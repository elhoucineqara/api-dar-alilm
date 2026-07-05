const express = require('express');
const multer = require('multer');
const router = express.Router();
const User = require('../models/User');
const Course = require('../models/Course');
const Category = require('../models/Category');
const Enrollment = require('../models/Enrollment');
const {
  createStripeOnboardingLink,
  syncStripeConnectedAccount,
} = require('../lib/marketplace-stripe');
const {
  getPayPalReturnRedirectUrl,
} = require('../lib/paypal-marketplace');
const { requireCreatorUser } = require('../lib/creator-access');
const { getAdminContactEmailTemplate, sendEmail } = require('../lib/email');
const { getPlatformSettings, serializePlatformSettings } = require('../lib/platform-settings');
const { serializeUserPaymentSettings } = require('../lib/user-payment-settings');
const { uploadFileToGridFS } = require('../lib/gridfs');
const {
  ALL_EXTENSIONS,
  IMAGE_EXTENSIONS,
  createMemoryUpload,
  getUploadErrorResponse,
  validateUploadedFile,
} = require('../lib/secure-upload');

const Module = require('../models/Module');
const Section = require('../models/Section');
const Progress = require('../models/Progress');

const courseContentUpload = createMemoryUpload(50 * 1024 * 1024);

const instructorEmailUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 16,
  },
});

function getDisplayName(user) {
  const fullName = `${user?.firstName || ''} ${user?.lastName || ''}`.trim();
  return fullName || user?.email || 'User';
}

function parseJsonArray(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseInstructorEmailPayload(req) {
  const subject = String(req.body?.subject || '').trim();
  const message = typeof req.body?.message === 'string' ? req.body.message : '';
  const messageHtml = typeof req.body?.html === 'string' ? req.body.html : '';
  const inlineImageMeta = parseJsonArray(req.body?.inlineImageMeta);
  const attachmentFiles = Array.isArray(req.files?.attachments) ? req.files.attachments : [];
  const inlineImageFiles = Array.isArray(req.files?.inlineImages) ? req.files.inlineImages : [];
  const attachments = attachmentFiles.map((file) => {
    const metadata = validateUploadedFile(file, { allowedExtensions: ALL_EXTENSIONS });
    return {
      filename: metadata.originalName,
      content: file.buffer,
      contentType: metadata.contentType,
    };
  });
  const inlineImages = inlineImageFiles.map((file, index) => {
    const metadata = validateUploadedFile(file, { allowedExtensions: IMAGE_EXTENSIONS });
    return {
      filename: metadata.originalName,
      content: file.buffer,
      contentType: metadata.contentType,
      cid:
        typeof inlineImageMeta[index]?.cid === 'string' && inlineImageMeta[index].cid.trim()
          ? inlineImageMeta[index].cid.trim()
          : `inline-image-${Date.now()}-${index}`,
    };
  });

  return {
    subject,
    message,
    messageHtml,
    attachments: [...attachments, ...inlineImages],
  };
}

function normalizeIdList(value) {
  const rawIds = Array.isArray(value) ? value : parseJsonArray(value);

  return [
    ...new Set(
      rawIds
        .map((id) => String(id || '').trim())
        .filter((id) => /^[a-f\d]{24}$/i.test(id))
    ),
  ];
}

function parseBooleanParam(value) {
  return value === 'true' || value === true || value === '1';
}

function getPayPalMerchantIdFromReturn(query = {}) {
  return (
    (typeof query.merchantIdInPayPal === 'string' && query.merchantIdInPayPal.trim()) ||
    (typeof query.merchant_id === 'string' && query.merchant_id.trim()) ||
    null
  );
}

router.get('/payment-settings/paypal/return', async (req, res) => {
  try {
    const trackingId =
      (typeof req.query.merchantId === 'string' && req.query.merchantId.trim()) ||
      (typeof req.query.tracking_id === 'string' && req.query.tracking_id.trim()) ||
      null;

    if (!trackingId) {
      return res.redirect(getPayPalReturnRedirectUrl('error', 'Missing PayPal tracking id.'));
    }

    const user = await User.findOne({
      'paymentSettings.paypalMerchant.trackingId': trackingId,
    });

    if (!user) {
      return res.redirect(getPayPalReturnRedirectUrl('error', 'PayPal onboarding session not found.'));
    }

    const merchantId = getPayPalMerchantIdFromReturn(req.query);
    const permissionsGranted =
      parseBooleanParam(req.query.permissionsGranted) || parseBooleanParam(req.query.consentStatus);
    const accountStatus =
      (typeof req.query.accountStatus === 'string' && req.query.accountStatus.trim()) || null;
    const emailConfirmed = parseBooleanParam(req.query.primaryEmailConfirmed);
    const frontendReturnPath =
      user.paymentSettings?.paypalMerchant?.frontendReturnPath || '/instructor/payments';

    user.paymentSettings = user.paymentSettings || {};
    user.paymentSettings.paypalMerchant = {
      ...(user.paymentSettings.paypalMerchant || {}),
      merchantId: merchantId || user.paymentSettings.paypalMerchant?.merchantId,
      accountStatus,
      onboardingStatus: merchantId && permissionsGranted ? 'linked' : 'needs_attention',
      permissionsGranted,
      paymentsReceivable: permissionsGranted,
      primaryEmailConfirmed: emailConfirmed || permissionsGranted,
      connectedAt:
        user.paymentSettings.paypalMerchant?.connectedAt ||
        (merchantId ? new Date() : undefined),
      lastSyncedAt: new Date(),
    };

    await user.save();

    return res.redirect(
      getPayPalReturnRedirectUrl(
        merchantId && permissionsGranted ? 'connected' : 'needs_attention',
        merchantId && permissionsGranted
          ? 'PayPal account connected successfully.'
          : 'PayPal onboarding still needs attention.',
        {
          frontendReturnPath,
        }
      )
    );
  } catch (error) {
    console.error('Error handling PayPal instructor return:', error);
    return res.redirect(getPayPalReturnRedirectUrl('error', 'PayPal onboarding failed.'));
  }
});

router.get('/payment-settings', requireCreatorUser, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (user.paymentSettings?.stripeConnect?.accountId) {
      await syncStripeConnectedAccount(user);
    }

    const platformSettings = await getPlatformSettings();

    return res.json({
      paymentSettings: serializeUserPaymentSettings(user),
      platform: serializePlatformSettings(platformSettings),
    });
  } catch (error) {
    console.error('Error fetching instructor payment settings:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

router.post('/payment-settings/stripe/onboarding-link', requireCreatorUser, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const onboarding = await createStripeOnboardingLink(user);
    return res.json(onboarding);
  } catch (error) {
    console.error('Error creating Stripe onboarding link:', error);
    return res.status(error.statusCode || 500).json({
      error: error.message || 'Unable to start Stripe onboarding.',
    });
  }
});

router.post('/payment-settings/paypal/onboarding-link', requireCreatorUser, async (req, res) => {
  try {
    return res.status(400).json({
      error:
        'PayPal is not used for instructor revenue anymore. Instructors should connect Stripe only.',
    });
  } catch (error) {
    console.error('Error creating PayPal onboarding link:', error);
    return res.status(error.statusCode || 500).json({
      error: error.message || 'Unable to start PayPal onboarding.',
    });
  }
});

// PUT update instructor profile
router.put('/profile', requireCreatorUser, async (req, res) => {
  try {
    const { firstName, lastName, email, phone, bio, profileImage } = req.body;
    
    const user = await User.findById(req.user.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Update fields
    if (firstName) user.firstName = firstName;
    if (lastName) user.lastName = lastName;
    if (email) user.email = email;
    if (phone !== undefined) user.phone = phone;
    if (bio !== undefined) user.bio = bio;
    if (profileImage !== undefined) user.profileImage = profileImage;

    await user.save();

    // Return updated user
    res.json({
      user: {
        id: user._id.toString(),
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        phone: user.phone,
        bio: user.bio,
        profileImage: user.profileImage,
      }
    });
  } catch (error) {
    console.error('Error updating profile:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET all categories for the instructor
router.get('/categories', requireCreatorUser, async (req, res) => {
  try {
    const categories = await Category.find({ instructorId: req.user.userId }).sort({ createdAt: -1 });
    res.json({ categories });
  } catch (error) {
    console.error('Error fetching categories:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST create a new category
router.post('/categories', requireCreatorUser, async (req, res) => {
  try {
    const { name, description } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'Category name is required' });
    }

    const category = new Category({
      name,
      description,
      instructorId: req.user.userId,
    });

    await category.save();
    res.status(201).json({ category });
  } catch (error) {
    console.error('Error creating category:', error);
    if (error.code === 11000) {
      return res.status(400).json({ error: 'Category name already exists' });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT update a category
router.put('/categories/:id', requireCreatorUser, async (req, res) => {
  try {
    const { name, description } = req.body;
    const categoryId = req.params.id;

    if (!name) {
      return res.status(400).json({ error: 'Category name is required' });
    }

    const category = await Category.findOne({ _id: categoryId, instructorId: req.user.userId });
    if (!category) {
      return res.status(404).json({ error: 'Category not found' });
    }

    category.name = name;
    category.description = description;
    await category.save();

    res.json({ category });
  } catch (error) {
    console.error('Error updating category:', error);
    if (error.code === 11000) {
      return res.status(400).json({ error: 'Category name already exists' });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE a category
router.delete('/categories/:id', requireCreatorUser, async (req, res) => {
  try {
    const categoryId = req.params.id;

    const category = await Category.findOne({ _id: categoryId, instructorId: req.user.userId });
    if (!category) {
      return res.status(404).json({ error: 'Category not found' });
    }

    // Check if category is used by any courses
    const coursesUsingCategory = await Course.countDocuments({ categoryId });
    if (coursesUsingCategory > 0) {
      return res.status(400).json({ 
        error: `Cannot delete category. It is used by ${coursesUsingCategory} course(s)` 
      });
    }

    await Category.findByIdAndDelete(categoryId);
    res.json({ message: 'Category deleted successfully' });
  } catch (error) {
    console.error('Error deleting category:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET instructor statistics
router.get('/statistics', requireCreatorUser, async (req, res) => {
  try {
    const instructorId = req.user.userId;

    const totalCourses = await Course.countDocuments({ instructorId });
    const publishedCourses = await Course.countDocuments({ instructorId, status: 'published' });

    const instructorCourses = await Course.find({ instructorId }).select('_id');
    const courseIds = instructorCourses.map((course) => course._id);

    const totalEnrollments = await Enrollment.countDocuments({ courseId: { $in: courseIds } });
    const enrollments = await Enrollment.find({ courseId: { $in: courseIds } }).distinct('userId');
    const totalStudents = enrollments.length;

    res.json({
      statistics: {
        totalCourses,
        publishedCourses,
        draftCourses: totalCourses - publishedCourses,
        totalStudents,
        totalEnrollments,
      },
    });
  } catch (error) {
    console.error('Error fetching statistics:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET all students for the instructor's courses
router.get('/students', requireCreatorUser, async (req, res) => {
  try {
    const instructorId = req.user.userId;
    const { courseId } = req.query;

    const instructorCourses = await Course.find({ instructorId }).select('_id');
    const courseIds = instructorCourses.map((c) => c._id);

    let enrollmentQuery = { courseId: { $in: courseIds } };
    if (courseId && courseId !== 'all') {
      enrollmentQuery.courseId = courseId;
    }

    const enrollments = await Enrollment.find(enrollmentQuery).populate('userId');
    const studentIds = [
      ...new Set(enrollments.map((e) => e.userId?._id?.toString()).filter(Boolean)),
    ];

    const studentsData = await Promise.all(
      studentIds.map(async (studentId) => {
        const student = await User.findById(studentId);
        if (!student) return null;

        const studentEnrollments = enrollments.filter(
          (e) => e.userId?._id?.toString() === studentId
        );
        const studentCourseIds = studentEnrollments.map((enrollment) => enrollment.courseId);
        const enrollmentDates = studentEnrollments
          .map((enrollment) => enrollment.enrolledAt)
          .filter(Boolean)
          .sort((a, b) => new Date(a).getTime() - new Date(b).getTime());

        const progressData = await Promise.all(
          studentEnrollments.map(async (enrollment) => {
            const progress = await Progress.findOne({
              userId: studentId,
              courseId: enrollment.courseId,
            });
            return progress?.overallProgress || 0;
          })
        );

        const totalProgress =
          progressData.length > 0
            ? progressData.reduce((sum, p) => sum + p, 0) / progressData.length
            : 0;

        const lastProgress = await Progress.findOne({
          userId: studentId,
          courseId: { $in: studentCourseIds },
        })
          .sort({ lastAccessedAt: -1 })
          .select('lastAccessedAt');

        return {
          _id: student._id,
          firstName: student.firstName,
          lastName: student.lastName,
          email: student.email,
          enrolledCourses: studentEnrollments.length,
          totalProgress: Math.round(totalProgress),
          lastActive: lastProgress?.lastAccessedAt || null,
          createdAt: student.createdAt,
          firstEnrolledAt: enrollmentDates[0] || null,
        };
      })
    );

    const students = studentsData
      .filter((s) => s !== null)
      .sort((a, b) =>
        `${a.firstName} ${a.lastName}`.localeCompare(`${b.firstName} ${b.lastName}`)
      );

    res.json({ students });
  } catch (error) {
    console.error('Error fetching students:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST contact selected students enrolled in the instructor's courses
router.post(
  '/students/contact',
  requireCreatorUser,
  instructorEmailUpload.fields([
    { name: 'attachments', maxCount: 8 },
    { name: 'inlineImages', maxCount: 12 },
  ]),
  async (req, res) => {
    try {
      const requestedStudentIds = normalizeIdList(req.body?.userIds);
      const { subject, message, messageHtml, attachments } = parseInstructorEmailPayload(req);

      if (requestedStudentIds.length === 0) {
        return res.status(400).json({
          error: 'Select at least one student to contact.',
        });
      }

      if (!subject || (!messageHtml.trim() && !String(message || '').trim())) {
        return res.status(400).json({
          error: 'Subject and email content are required.',
        });
      }

      const instructorId = req.user.userId;
      const instructorCourses = await Course.find({ instructorId }).select('_id').lean();
      const courseIds = instructorCourses.map((course) => course._id);

      if (courseIds.length === 0) {
        return res.status(400).json({
          error: 'You need at least one course before contacting students.',
        });
      }

      const eligibleEnrollments = await Enrollment.find({
        courseId: { $in: courseIds },
        userId: { $in: requestedStudentIds },
      })
        .select('userId')
        .lean();
      const eligibleStudentIds = [
        ...new Set(eligibleEnrollments.map((enrollment) => String(enrollment.userId))),
      ];

      const students = await User.find({
        _id: { $in: eligibleStudentIds },
        role: 'student',
        email: { $exists: true, $ne: '' },
      })
        .select('firstName lastName email')
        .lean();

      if (students.length === 0) {
        return res.status(400).json({
          error: 'No eligible students found for your courses.',
        });
      }

      const [instructorUser, settings] = await Promise.all([
        User.findById(instructorId).select('firstName lastName email').lean(),
        getPlatformSettings(),
      ]);
      const serializedSettings = serializePlatformSettings(settings);
      const senderEmail = instructorUser?.email || serializedSettings.supportEmail;
      const emailResults = await Promise.all(
        students.map(async (student) => {
          const result = await sendEmail({
            to: student.email,
            subject,
            html: getAdminContactEmailTemplate({
              platformName: serializedSettings.platformName,
              recipientName: getDisplayName(student),
              adminName: getDisplayName(instructorUser || {}),
              subject,
              message: String(message || '').trim(),
              messageHtml,
              senderContext: "l'espace instructeur",
              supportEmail: senderEmail,
            }),
            attachments,
          });

          return {
            userId: String(student._id),
            email: student.email,
            success: result.success,
            error: result.error || null,
          };
        })
      );

      const sent = emailResults.filter((result) => result.success);
      const failed = emailResults.filter((result) => !result.success);
      const skippedCount = requestedStudentIds.length - students.length;

      if (sent.length === 0) {
        return res.status(500).json({
          error: failed[0]?.error || 'Unable to send email.',
          failed,
          skippedCount,
        });
      }

      return res.json({
        message: `${sent.length} email(s) sent.${failed.length ? ` ${failed.length} failed.` : ''}${
          skippedCount > 0 ? ` ${skippedCount} skipped.` : ''
        }`,
        sentCount: sent.length,
        failed,
        skippedCount,
      });
    } catch (error) {
      console.error('Error contacting instructor students:', error);
      return res.status(error.statusCode || 400).json({
        error: error.message || 'Unable to send email.',
      });
    }
  }
);

// GET detailed student data for an instructor
router.get('/students/:id', requireCreatorUser, async (req, res) => {
  try {
    const studentId = req.params.id;
    const instructorId = req.user.userId;

    const student = await User.findById(studentId).select('-password');
    if (!student) {
      return res.status(404).json({ error: 'Student not found' });
    }

    const instructorCourses = await Course.find({ instructorId });
    const courseIds = instructorCourses.map((c) => c._id);

    const enrollments = await Enrollment.find({
      userId: studentId,
      courseId: { $in: courseIds },
    }).populate('courseId');

    const coursesProgress = await Promise.all(
      enrollments.map(async (enrollment) => {
        const course = enrollment.courseId;
        const progress = await Progress.findOne({
          userId: studentId,
          courseId: course._id,
        });

        const modules = await Module.find({ courseId: course._id });
        const totalSections = modules.reduce((sum, m) => sum + (m.sections?.length || 0), 0);
        // Modules usually have quizId directly in the model now, let's check
        const totalQuizzes = modules.filter(m => m.quiz).length;

        return {
          courseId: course._id,
          courseTitle: course.title,
          overallProgress: progress?.overallProgress || 0,
          completedSections: progress?.completedSections?.length || 0,
          totalSections,
          completedQuizzes: progress?.completedQuizzes?.length || 0,
          totalQuizzes,
          completedFinalExam: progress?.completedFinalExam || false,
          lastAccessedAt: progress?.lastAccessedAt || null,
          enrolledAt: enrollment.enrolledAt,
        };
      })
    );

    res.json({
      student: {
        _id: student._id,
        firstName: student.firstName,
        lastName: student.lastName,
        email: student.email,
        createdAt: student.createdAt,
      },
      courses: coursesProgress,
    });
  } catch (error) {
    console.error('Error fetching student details:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET analytics data for instructor
router.get('/analytics', requireCreatorUser, async (req, res) => {
  try {
    const instructorId = req.user.userId;

    // Get all courses by instructor
    const courses = await Course.find({ instructorId });
    const courseIds = courses.map(c => c._id);

    // Get total enrollments
    const enrollments = await Enrollment.find({ courseId: { $in: courseIds } });
    const activeEnrollments = enrollments.filter(e => e.status === 'active').length;

    // Get unique students
    const uniqueStudents = new Set(enrollments.map(e => e.userId?.toString()).filter(Boolean));
    const totalStudents = uniqueStudents.size;

    // Calculate total revenue (assuming course price * enrollments)
    let totalRevenue = 0;
    const coursesData = [];

    for (const course of courses) {
      const courseEnrollments = enrollments.filter(e => e.courseId.toString() === course._id.toString());
      const revenue = course.price * courseEnrollments.length;
      totalRevenue += revenue;

      // Calculate completion rate
      const completedEnrollments = courseEnrollments.filter(e => e.progress === 100).length;
      const completionRate = courseEnrollments.length > 0 
        ? Math.round((completedEnrollments / courseEnrollments.length) * 100) 
        : 0;

      coursesData.push({
        _id: course._id,
        title: course.title,
        enrollments: courseEnrollments.length,
        completionRate,
        revenue,
      });
    }

    // Sort courses by enrollments
    coursesData.sort((a, b) => b.enrollments - a.enrollments);

    res.json({
      totalStudents,
      totalCourses: courses.length,
      totalRevenue,
      activeEnrollments,
      coursesData,
    });
  } catch (error) {
    console.error('Error fetching analytics:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET forum posts for instructor's courses
router.get('/forum', requireCreatorUser, async (req, res) => {
  try {
    const instructorId = req.user.userId;

    // Get all courses by instructor
    const courses = await Course.find({ instructorId }).select('_id');
    const courseIds = courses.map(c => c._id);

    // Import ForumPost model
    const ForumPost = require('../models/ForumPost');

    // Get all forum posts related to instructor's courses or created by instructor
    const posts = await ForumPost.find({
      $or: [
        { courseId: { $in: courseIds } },
        { authorId: instructorId }
      ]
    })
      .populate('authorId', 'firstName lastName role profileImage')
      .populate('courseId', 'title')
      .sort({ createdAt: -1 })
      .lean();

    // Transform data to match frontend interface
    const transformedPosts = posts.map(post => ({
      ...post,
      author: post.authorId,
      replies: post.replies?.length || 0,
    }));

    res.json({ posts: transformedPosts });
  } catch (error) {
    console.error('Error fetching forum posts:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST change password
router.post('/change-password', requireCreatorUser, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current password and new password are required' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters long' });
    }

    const user = await User.findById(req.user.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Verify current password
    const isMatch = await user.comparePassword(currentPassword);
    if (!isMatch) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }

    // Update password
    user.password = newPassword;
    await user.save();

    res.json({ message: 'Password changed successfully' });
  } catch (error) {
    console.error('Error changing password:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT update notification settings
router.put('/notifications', requireCreatorUser, async (req, res) => {
  try {
    const { emailNotifications, courseUpdates, studentMessages, marketingEmails } = req.body;
    
    // For now, just return success (notification settings can be stored in user model if needed)
    // In a real app, you would save these to the database
    res.json({ 
      message: 'Notification settings updated successfully',
      settings: {
        emailNotifications: emailNotifications !== undefined ? emailNotifications : true,
        courseUpdates: courseUpdates !== undefined ? courseUpdates : true,
        studentMessages: studentMessages !== undefined ? studentMessages : true,
        marketingEmails: marketingEmails !== undefined ? marketingEmails : false,
      }
    });
  } catch (error) {
    console.error('Error updating notification settings:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST upload file
router.post('/upload', requireCreatorUser, (req, res, next) => {
  courseContentUpload.single('file')(req, res, (err) => {
    if (err) {
      const response = getUploadErrorResponse(err, '50MB');
      return res.status(response.status).json(response.body);
    }
    next();
  });
}, async (req, res) => {
  try {
    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    const metadata = validateUploadedFile(file, { allowedExtensions: ALL_EXTENSIONS });
    
    const fileId = await uploadFileToGridFS(file.buffer, metadata.storageName, {
      originalName: metadata.originalName,
      uploadedBy: req.user.userId,
      uploadedAt: new Date(),
      contentType: metadata.contentType,
      size: metadata.size,
      extension: metadata.extension,
      category: metadata.category,
    });

    const fileUrl = `/api/files/${fileId}`;
    
    res.status(200).json({ 
      fileId,
      fileUrl,
      fileName: metadata.originalName,
      fileSize: metadata.size,
      fileType: metadata.contentType
    });
  } catch (error) {
    console.error('Error uploading file:', error);
    const response = getUploadErrorResponse(error, '50MB');
    res.status(response.status).json(response.body);
  }
});

module.exports = router;
