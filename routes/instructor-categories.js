const express = require('express');

const Category = require('../models/Category');
const Course = require('../models/Course');
const {
  ensureDefaultCategories,
  isSupportedCategoryIcon,
  slugifyCategoryName,
} = require('../lib/category-catalog');
const { requireCreatorUser } = require('../lib/creator-access');
const { requireAuthUser } = require('../lib/request-auth');

const router = express.Router();

async function requireInstructorAccess(req, res, next) {
  return requireCreatorUser(req, res, next);
}

async function requireAdminAccess(req, res, next) {
  try {
    const authUser = await requireAuthUser(req);

    if (authUser.role !== 'admin') {
      return res.status(403).json({
        error: 'Only admins can manage categories.',
      });
    }

    req.user = authUser;
    return next();
  } catch (error) {
    return res.status(error.statusCode || 401).json({
      error: error.message || 'Unauthorized',
    });
  }
}

function buildCategoryPayload(body = {}) {
  const name = String(body.name || '').trim();
  const description = String(body.description || '').trim();
  const icon = isSupportedCategoryIcon(body.icon) ? String(body.icon).trim() : 'grid';

  return {
    name,
    description,
    icon,
    isDefault: false,
    order: 999,
  };
}

function isCategoryApproved(category) {
  return !category || !category.approvalStatus || category.approvalStatus === 'approved';
}

function isCategoryPending(category) {
  return category?.approvalStatus === 'pending';
}

function getCategoryRequesterId(category) {
  return String(category?.requestedBy || category?.createdBy || '');
}

function canManagePendingRequest(user, category) {
  if (!user || !category || !isCategoryPending(category)) {
    return false;
  }

  if (user.role === 'admin') {
    return true;
  }

  return getCategoryRequesterId(category) === String(user.userId || '');
}

async function loadPendingRequests(user) {
  const query = {
    approvalStatus: 'pending',
  };

  if (user.role !== 'admin') {
    query.requestedBy = user.userId;
  }

  return Category.find(query)
    .populate('requestedBy', 'firstName lastName email')
    .sort({ createdAt: -1 })
    .lean();
}

async function findCategoryBySlug(name, options = {}) {
  return Category.findOne({
    slug: slugifyCategoryName(name),
    ...(options.excludeId ? { _id: { $ne: options.excludeId } } : {}),
  });
}

function getDuplicateCategoryMessage(category) {
  if (isCategoryApproved(category)) {
    return 'A category with the same name already exists.';
  }

  return 'A category request with the same name is already awaiting admin approval.';
}

async function syncApprovedCategoryToCourses(categoryId) {
  await Course.updateMany(
    { requestedCategoryId: categoryId },
    {
      $set: {
        categoryId,
      },
      $unset: {
        requestedCategoryId: '',
      },
    }
  );
}

async function clearPendingCategoryLinks(categoryId) {
  await Course.updateMany(
    { requestedCategoryId: categoryId },
    {
      $unset: {
        requestedCategoryId: '',
      },
    }
  );
}

router.get('/', requireInstructorAccess, async (req, res) => {
  try {
    const [categories, pendingRequests] = await Promise.all([
      ensureDefaultCategories({
        adminUserId: req.user.role === 'admin' ? req.user.userId : null,
      }),
      loadPendingRequests(req.user),
    ]);

    return res.json({ categories, pendingRequests });
  } catch (error) {
    console.error('Error fetching instructor categories:', error);
    return res.status(500).json({
      error: 'Internal server error',
    });
  }
});

router.post('/', requireInstructorAccess, async (req, res) => {
  try {
    const payload = buildCategoryPayload(req.body);

    if (!payload.name) {
      return res.status(400).json({
        error: 'Category name is required.',
      });
    }

    const existingCategory = await findCategoryBySlug(payload.name);
    if (existingCategory) {
      return res.status(400).json({
        error: getDuplicateCategoryMessage(existingCategory),
      });
    }

    const isAdmin = req.user.role === 'admin';
    const now = new Date();
    const category = new Category({
      ...payload,
      createdBy: req.user.userId,
      requestedBy: isAdmin ? undefined : req.user.userId,
      approvalStatus: isAdmin ? 'approved' : 'pending',
      approvedBy: isAdmin ? req.user.userId : undefined,
      approvedAt: isAdmin ? now : undefined,
    });

    await category.save();

    return res.status(201).json({
      category,
      message: isAdmin
        ? 'Category created successfully.'
        : 'Category request submitted and awaiting admin approval.',
    });
  } catch (error) {
    console.error('Error creating category:', error);
    if (error.code === 11000) {
      return res.status(400).json({
        error: 'A category with the same name already exists.',
      });
    }

    return res.status(500).json({
      error: 'Internal server error',
    });
  }
});

router.put('/:id', requireInstructorAccess, async (req, res) => {
  try {
    const category = await Category.findById(req.params.id);

    if (!category) {
      return res.status(404).json({
        error: 'Category not found.',
      });
    }

    if (category.isDefault) {
      return res.status(400).json({
        error: 'Default categories are locked. Create a new category if you need an additional one.',
      });
    }

    if (req.user.role !== 'admin' && !canManagePendingRequest(req.user, category)) {
      return res.status(403).json({
        error: 'You can only edit your own pending category requests.',
      });
    }

    const payload = buildCategoryPayload(req.body);

    if (!payload.name) {
      return res.status(400).json({
        error: 'Category name is required.',
      });
    }

    const existingCategory = await findCategoryBySlug(payload.name, { excludeId: category._id });
    if (existingCategory) {
      return res.status(400).json({
        error: getDuplicateCategoryMessage(existingCategory),
      });
    }

    category.name = payload.name;
    category.description = payload.description;
    category.icon = payload.icon;
    category.order = payload.order;
    category.isDefault = false;

    if (req.user.role === 'admin' && isCategoryApproved(category)) {
      category.approvedBy = category.approvedBy || req.user.userId;
      category.approvedAt = category.approvedAt || new Date();
    } else {
      category.approvalStatus = 'pending';
      category.requestedBy = category.requestedBy || req.user.userId;
      category.approvedBy = undefined;
      category.approvedAt = undefined;
    }

    await category.save();

    return res.json({
      category,
      message:
        req.user.role === 'admin' && isCategoryApproved(category)
          ? 'Category updated successfully.'
          : 'Category request updated successfully.',
    });
  } catch (error) {
    console.error('Error updating category:', error);
    if (error.code === 11000) {
      return res.status(400).json({
        error: 'A category with the same name already exists.',
      });
    }

    return res.status(500).json({
      error: 'Internal server error',
    });
  }
});

router.post('/:id/approve', requireAdminAccess, async (req, res) => {
  try {
    const category = await Category.findById(req.params.id);

    if (!category) {
      return res.status(404).json({
        error: 'Category not found.',
      });
    }

    if (category.isDefault || isCategoryApproved(category)) {
      return res.status(400).json({
        error: 'This category is already approved.',
      });
    }

    category.approvalStatus = 'approved';
    category.approvedBy = req.user.userId;
    category.approvedAt = new Date();
    category.createdBy = category.createdBy || req.user.userId;

    await category.save();
    await syncApprovedCategoryToCourses(category._id);

    return res.json({
      category,
      message: 'Category approved successfully.',
    });
  } catch (error) {
    console.error('Error approving category:', error);
    return res.status(500).json({
      error: 'Internal server error',
    });
  }
});

router.delete('/:id', requireInstructorAccess, async (req, res) => {
  try {
    const category = await Category.findById(req.params.id);

    if (!category) {
      return res.status(404).json({
        error: 'Category not found.',
      });
    }

    if (category.isDefault) {
      return res.status(400).json({
        error: 'Default categories cannot be deleted.',
      });
    }

    const isPendingRequest = isCategoryPending(category);
    const canDeletePendingRequest = canManagePendingRequest(req.user, category);

    if (req.user.role !== 'admin' && !canDeletePendingRequest) {
      return res.status(403).json({
        error: 'You can only delete your own pending category requests.',
      });
    }

    if (isPendingRequest) {
      await clearPendingCategoryLinks(category._id);
      await Category.deleteOne({ _id: category._id });

      return res.json({
        message:
          req.user.role === 'admin'
            ? 'Category request rejected successfully.'
            : 'Category request cancelled successfully.',
      });
    }

    const coursesUsingCategory = await Course.countDocuments({ categoryId: category._id });
    if (coursesUsingCategory > 0) {
      return res.status(400).json({
        error: `Cannot delete category. It is used by ${coursesUsingCategory} course(s).`,
      });
    }

    await Category.deleteOne({ _id: category._id });

    return res.json({
      message: 'Category deleted successfully.',
    });
  } catch (error) {
    console.error('Error deleting category:', error);
    return res.status(500).json({
      error: 'Internal server error',
    });
  }
});

module.exports = router;