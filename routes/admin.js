const express = require('express');
const multer = require('multer');

const Category = require('../models/Category');
const Certificate = require('../models/Certificate');
const Course = require('../models/Course');
const CoursePayment = require('../models/CoursePayment');
const Enrollment = require('../models/Enrollment');
const ForumPost = require('../models/ForumPost');
const Progress = require('../models/Progress');
const User = require('../models/User');
const { canUserSellCoursesPublicly } = require('../lib/creator-access');
const {
  getPlatformSettings,
  normalizePlatformFeePercent,
  serializePlatformSettings,
  updatePlatformPaymentSettings,
  updatePlatformSettings,
} = require('../lib/platform-settings');
const { getFrontendUrl } = require('../lib/course-payments');
const { getAdminContactEmailTemplate, sendEmail } = require('../lib/email');
const {
  createStripeOnboardingLink,
  syncStripeConnectedAccount,
} = require('../lib/marketplace-stripe');
const { sendPasswordResetEmail } = require('../lib/password-reset');
const {
  getInstructorPaymentProviderAvailability,
  serializeUserPaymentSettings,
} = require('../lib/user-payment-settings');
const { getInstructorModeStatus } = require('../lib/instructor-mode');
const { isReservedAdminEmail } = require('../lib/auth-user');
const { authenticateToken, authorizeRoles } = require('../middleware/auth');
const {
  ALL_EXTENSIONS,
  IMAGE_EXTENSIONS,
  validateUploadedFile,
} = require('../lib/secure-upload');

const router = express.Router();
const adminEmailUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 16,
  },
});

function toNumber(value) {
  return Number(Number(value || 0).toFixed(2));
}

function sumBy(items, getter) {
  return toNumber(items.reduce((total, item) => total + Number(getter(item) || 0), 0));
}

function incrementMapCount(map, key, amount = 1) {
  map.set(key, (map.get(key) || 0) + amount);
}

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

function parseAdminEmailPayload(req) {
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

function getAdminSettingsUrl(query = {}) {
  const url = new URL(`${getFrontendUrl()}/admin/settings`);

  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  });

  return url.toString();
}

async function loadAdminSettingsSnapshot(adminUserId, options = {}) {
  const settings = options.settings || (await getPlatformSettings());
  const adminUser = await User.findById(adminUserId);

  if (adminUser?.paymentSettings?.stripeConnect?.accountId) {
    await syncStripeConnectedAccount(adminUser);
  }

  const serializedSettings = serializePlatformSettings(settings);

  return {
    settings: serializedSettings,
    paymentSettings: serializeUserPaymentSettings(adminUser || {}),
    instructorMode: getInstructorModeStatus(adminUser || {}, serializedSettings),
  };
}

function getEffectivePlatformFeePercent(user, defaultPercent) {
  if (user?.role === 'admin') {
    return 0;
  }

  if (user?.customPlatformFeePercent !== undefined && user?.customPlatformFeePercent !== null) {
    return normalizePlatformFeePercent(user.customPlatformFeePercent, defaultPercent);
  }

  return normalizePlatformFeePercent(defaultPercent, defaultPercent);
}

function createMoneyMetric() {
  return {
    salesCount: 0,
    grossRevenue: 0,
    platformRevenue: 0,
    instructorRevenue: 0,
  };
}

function getOrCreateMoneyMetric(map, key) {
  const existing = map.get(key);
  if (existing) {
    return existing;
  }

  const metric = createMoneyMetric();
  map.set(key, metric);
  return metric;
}

function sortAccounts(accounts) {
  const rolePriority = {
    admin: 0,
    instructor: 1,
    student: 2,
  };
  const statusPriority = {
    blocked: 0,
    active: 1,
    deleted: 2,
  };

  return [...accounts].sort((left, right) => {
    const byRole = (rolePriority[left.role] || 99) - (rolePriority[right.role] || 99);
    if (byRole !== 0) {
      return byRole;
    }

    const byStatus =
      (statusPriority[left.accountStatus] || 99) - (statusPriority[right.accountStatus] || 99);
    if (byStatus !== 0) {
      return byStatus;
    }

    return left.email.localeCompare(right.email);
  });
}

function buildAccountSummary(users) {
  return users.reduce(
    (summary, user) => {
      summary.total += 1;
      summary[user.role] = (summary[user.role] || 0) + 1;
      summary[user.accountStatus || 'active'] =
        (summary[user.accountStatus || 'active'] || 0) + 1;
      return summary;
    },
    {
      total: 0,
      admin: 0,
      instructor: 0,
      student: 0,
      active: 0,
      blocked: 0,
      deleted: 0,
    }
  );
}

async function getDeletionBlockers(userId) {
  const [
    ownedCourses,
    ownedCategories,
    studentEnrollments,
    studentProgress,
    studentCertificates,
    studentPayments,
    instructorPayments,
    forumPosts,
    forumReplies,
  ] = await Promise.all([
    Course.countDocuments({ instructorId: userId }),
    Category.countDocuments({ instructorId: userId }),
    Enrollment.countDocuments({ userId }),
    Progress.countDocuments({ userId }),
    Certificate.countDocuments({ studentId: userId }),
    CoursePayment.countDocuments({ userId }),
    CoursePayment.countDocuments({ instructorId: userId }),
    ForumPost.countDocuments({ authorId: userId }),
    ForumPost.countDocuments({ 'replies.authorId': userId }),
  ]);

  const blockers = [];

  if (ownedCourses > 0) {
    blockers.push(`${ownedCourses} course(s)`);
  }
  if (ownedCategories > 0) {
    blockers.push(`${ownedCategories} categorie(s)`);
  }
  if (studentEnrollments > 0) {
    blockers.push(`${studentEnrollments} enrollment(s)`);
  }
  if (studentProgress > 0) {
    blockers.push(`${studentProgress} progress record(s)`);
  }
  if (studentCertificates > 0) {
    blockers.push(`${studentCertificates} certificate(s)`);
  }
  if (studentPayments > 0) {
    blockers.push(`${studentPayments} purchase payment(s)`);
  }
  if (instructorPayments > 0) {
    blockers.push(`${instructorPayments} instructor sale(s)`);
  }
  if (forumPosts > 0) {
    blockers.push(`${forumPosts} forum post(s)`);
  }
  if (forumReplies > 0) {
    blockers.push(`${forumReplies} forum replie(s)`);
  }

  return blockers;
}

async function getManageableUserOrThrow(userId, currentAdminUserId, options = {}) {
  const {
    allowSelf = false,
    allowAdminRole = false,
    allowReservedAdmin = false,
    allowDeleted = false,
  } = options;

  const user = await User.findById(userId);
  if (!user) {
    const error = new Error('User not found.');
    error.statusCode = 404;
    throw error;
  }

  if (!allowSelf && String(user._id) === String(currentAdminUserId)) {
    const error = new Error('You cannot apply this action to your current admin account.');
    error.statusCode = 400;
    throw error;
  }

  if (!allowAdminRole && user.role === 'admin') {
    const error = new Error('This action is not available for admin accounts.');
    error.statusCode = 400;
    throw error;
  }

  if (!allowReservedAdmin && isReservedAdminEmail(user.email)) {
    const error = new Error('The reserved platform admin account cannot be modified here.');
    error.statusCode = 400;
    throw error;
  }

  if (!allowDeleted && user.accountStatus === 'deleted') {
    const error = new Error('This account is already deleted.');
    error.statusCode = 400;
    throw error;
  }

  return user;
}

function normalizeBulkUserIds(userIds) {
  let normalizedValues = userIds;

  if (typeof normalizedValues === 'string') {
    try {
      const parsed = JSON.parse(normalizedValues);
      normalizedValues = parsed;
    } catch {
      normalizedValues = normalizedValues.split(',');
    }
  }

  if (!Array.isArray(normalizedValues)) {
    return [];
  }

  return [
    ...new Set(normalizedValues.map((userId) => String(userId || '').trim()).filter(Boolean)),
  ];
}

async function collectBulkManageableUsers(userIds, currentAdminUserId, options = {}) {
  const normalizedUserIds = normalizeBulkUserIds(userIds);

  if (normalizedUserIds.length === 0) {
    const error = new Error('Select at least one account.');
    error.statusCode = 400;
    throw error;
  }

  const results = await Promise.allSettled(
    normalizedUserIds.map((userId) =>
      getManageableUserOrThrow(userId, currentAdminUserId, options)
    )
  );

  const users = [];
  const skipped = [];

  results.forEach((result, index) => {
    const requestedUserId = normalizedUserIds[index];

    if (result.status === 'fulfilled') {
      users.push(result.value);
      return;
    }

    skipped.push({
      userId: requestedUserId,
      reason: result.reason?.message || 'This account could not be processed.',
    });
  });

  return {
    users,
    skipped,
  };
}

router.get('/dashboard', authenticateToken, authorizeRoles('admin'), async (req, res) => {
  try {
    const [settings, adminUser, courses, enrollments, allUsers, completedPayments] =
      await Promise.all([
        getPlatformSettings(),
        User.findById(req.user.userId),
        Course.find({})
          .select('title price status instructorId createdAt updatedAt')
          .lean(),
        Enrollment.find({})
          .select('userId courseId status createdAt enrolledAt')
          .lean(),
        User.find({})
          .select(
            'firstName lastName email role paymentSettings customPlatformFeePercent accountStatus accountStatusReason googleId createdAt'
          )
          .lean(),
        CoursePayment.find({ status: 'completed' })
          .populate('courseId', 'title price status')
          .populate('userId', 'email firstName lastName')
          .populate('instructorId', 'email firstName lastName role')
          .sort({ paidAt: -1, createdAt: -1 })
          .lean(),
      ]);

    if (adminUser?.paymentSettings?.stripeConnect?.accountId) {
      await syncStripeConnectedAccount(adminUser);
    }

    const serializedSettings = serializePlatformSettings(settings);
    const defaultPlatformFeePercent = serializedSettings.platformFeePercent;
    const allActiveUsers = allUsers.filter((user) => user.accountStatus !== 'deleted');
    const sellerUsers = allActiveUsers.filter((user) =>
      canUserSellCoursesPublicly(user, serializedSettings)
    );

    const coursesByInstructorId = new Map();
    const courseIdsByInstructorId = new Map();
    const courseTitleById = new Map();
    for (const course of courses) {
      const courseId = String(course._id);
      const instructorId = String(course.instructorId || '');
      courseTitleById.set(courseId, course.title || 'Course');
      incrementMapCount(coursesByInstructorId, instructorId);

      const ownedCourseIds = courseIdsByInstructorId.get(instructorId) || [];
      ownedCourseIds.push(courseId);
      courseIdsByInstructorId.set(instructorId, ownedCourseIds);
    }

    const courseOwnerByCourseId = new Map(
      courses.map((course) => [String(course._id), String(course.instructorId || '')])
    );

    const studentEnrollmentCounts = new Map();
    const instructorEnrollmentCounts = new Map();
    for (const enrollment of enrollments) {
      const studentId = String(enrollment.userId || '');
      incrementMapCount(studentEnrollmentCounts, studentId);

      const ownerId = courseOwnerByCourseId.get(String(enrollment.courseId || ''));
      if (ownerId) {
        incrementMapCount(instructorEnrollmentCounts, ownerId);
      }
    }

    const sellerMetricsByUserId = new Map();
    const studentPurchaseMetricsByUserId = new Map();
    const topCoursesMap = new Map();

    for (const payment of completedPayments) {
      const sellerId = String(payment.instructorId?._id || payment.instructorId || '');
      const studentId = String(payment.userId?._id || payment.userId || '');
      const courseId = String(payment.courseId?._id || payment.courseId || '');

      if (sellerId) {
        const sellerMetric = getOrCreateMoneyMetric(sellerMetricsByUserId, sellerId);
        sellerMetric.salesCount += 1;
        sellerMetric.grossRevenue = toNumber(sellerMetric.grossRevenue + Number(payment.amount || 0));
        sellerMetric.platformRevenue = toNumber(
          sellerMetric.platformRevenue + Number(payment.platformFeeAmount || 0)
        );
        sellerMetric.instructorRevenue = toNumber(
          sellerMetric.instructorRevenue +
            Number(
              payment.instructorAmount !== undefined
                ? payment.instructorAmount
                : Number(payment.amount || 0) - Number(payment.platformFeeAmount || 0)
            )
        );
      }

      if (studentId) {
        const studentMetric = getOrCreateMoneyMetric(studentPurchaseMetricsByUserId, studentId);
        studentMetric.salesCount += 1;
        studentMetric.grossRevenue = toNumber(
          studentMetric.grossRevenue + Number(payment.amount || 0)
        );
      }

      if (courseId) {
        const current = topCoursesMap.get(courseId) || {
          courseId,
          title: payment.courseId?.title || courseTitleById.get(courseId) || 'Course',
          salesCount: 0,
          grossRevenue: 0,
          platformRevenue: 0,
        };

        current.salesCount += 1;
        current.grossRevenue = toNumber(current.grossRevenue + Number(payment.amount || 0));
        current.platformRevenue = toNumber(
          current.platformRevenue + Number(payment.platformFeeAmount || 0)
        );
        topCoursesMap.set(courseId, current);
      }
    }

    const overview = {
      totalCourses: courses.length,
      publishedCourses: courses.filter((course) => course.status === 'published').length,
      paidCourses: courses.filter((course) => Number(course.price || 0) > 0).length,
      freeCourses: courses.filter((course) => !course.price || Number(course.price) <= 0).length,
      totalSales: completedPayments.length,
      coursesSold: new Set(
        completedPayments
          .map((payment) => String(payment.courseId?._id || payment.courseId || ''))
          .filter(Boolean)
      ).size,
      grossRevenue: sumBy(completedPayments, (payment) => payment.amount),
      platformRevenue: sumBy(completedPayments, (payment) => payment.platformFeeAmount || 0),
      instructorRevenue: sumBy(
        completedPayments,
        (payment) =>
          payment.instructorAmount !== undefined
            ? payment.instructorAmount
            : Number(payment.amount || 0) - Number(payment.platformFeeAmount || 0)
      ),
      totalEnrollments: enrollments.length,
      studentAccounts: allActiveUsers.filter((user) => user.role === 'student').length,
      enrolledStudents: new Set(enrollments.map((enrollment) => String(enrollment.userId || ''))).size,
      sellerAccounts: sellerUsers.length,
      connectedStripeSellers: sellerUsers.filter((seller) =>
        getInstructorPaymentProviderAvailability(seller).stripe
      ).length,
      connectedPayPalSellers: sellerUsers.filter((seller) =>
        getInstructorPaymentProviderAvailability(seller).paypal
      ).length,
    };

    const paymentProviders = ['stripe', 'paypal'].map((provider) => {
      const providerPayments = completedPayments.filter((payment) => payment.provider === provider);
      return {
        provider,
        salesCount: providerPayments.length,
        grossRevenue: sumBy(providerPayments, (payment) => payment.amount),
        platformRevenue: sumBy(providerPayments, (payment) => payment.platformFeeAmount || 0),
      };
    });

    const topCourses = [...topCoursesMap.values()]
      .sort((left, right) => right.grossRevenue - left.grossRevenue || right.salesCount - left.salesCount)
      .slice(0, 6);

    const recentSales = completedPayments.slice(0, 8).map((payment) => ({
      id: String(payment._id),
      courseTitle: payment.courseId?.title || 'Course',
      studentName:
        payment.userId?.firstName || payment.userId?.lastName
          ? `${payment.userId?.firstName || ''} ${payment.userId?.lastName || ''}`.trim()
          : payment.userId?.email || 'Student',
      studentEmail: payment.userId?.email || null,
      instructorEmail: payment.instructorId?.email || null,
      provider: payment.provider,
      amount: toNumber(payment.amount),
      platformFeeAmount: toNumber(payment.platformFeeAmount || 0),
      instructorAmount: toNumber(
        payment.instructorAmount !== undefined
          ? payment.instructorAmount
          : Number(payment.amount || 0) - Number(payment.platformFeeAmount || 0)
      ),
      paidAt: payment.paidAt || payment.createdAt || null,
    }));

    const accounts = sortAccounts(
      allActiveUsers.map((user) => {
        const userId = String(user._id);
        const sellerMetrics = sellerMetricsByUserId.get(userId) || createMoneyMetric();
        const studentPurchaseMetrics = studentPurchaseMetricsByUserId.get(userId) || createMoneyMetric();
        const paymentAvailability =
          ['instructor', 'admin'].includes(user.role)
            ? getInstructorPaymentProviderAvailability(user)
            : { stripe: false, paypal: false };

        return {
          userId,
          firstName: user.firstName,
          lastName: user.lastName,
          fullName: getDisplayName(user),
          email: user.email,
          role: user.role,
          accountStatus: user.accountStatus || 'active',
          accountStatusReason: user.accountStatusReason || '',
          createdAt: user.createdAt || null,
          isReservedAdmin: isReservedAdminEmail(user.email),
          isCurrentAdmin: String(user._id) === String(req.user.userId),
          customPlatformFeePercent:
            user.customPlatformFeePercent !== undefined ? user.customPlatformFeePercent : null,
          effectivePlatformFeePercent: getEffectivePlatformFeePercent(
            user,
            defaultPlatformFeePercent
          ),
          sellerStats: {
            coursesOwned: coursesByInstructorId.get(userId) || 0,
            salesCount: sellerMetrics.salesCount,
            grossRevenue: toNumber(sellerMetrics.grossRevenue),
            platformRevenue: toNumber(sellerMetrics.platformRevenue),
            netRevenue: toNumber(sellerMetrics.instructorRevenue),
            enrollments: instructorEnrollmentCounts.get(userId) || 0,
            stripeConnected: paymentAvailability.stripe,
            paypalConnected: paymentAvailability.paypal,
          },
          studentStats: {
            enrollments: studentEnrollmentCounts.get(userId) || 0,
            purchasesCount: studentPurchaseMetrics.salesCount,
            purchasesAmount: toNumber(studentPurchaseMetrics.grossRevenue),
          },
        };
      })
    );

    const sellers = accounts
      .filter((account) => ['instructor', 'admin'].includes(account.role))
      .map((account) => ({
        sellerId: account.userId,
        email: account.email,
        role: account.role,
        stripe: account.sellerStats.stripeConnected,
        paypal: account.sellerStats.paypalConnected,
      }));

    const adminSellerMetrics =
      sellerMetricsByUserId.get(String(req.user.userId)) || createMoneyMetric();

    return res.json({
      currentAdmin: {
        userId: String(req.user.userId),
        email: adminUser?.email || null,
        fullName: getDisplayName(adminUser || {}),
      },
      settings: serializedSettings,
      overview,
      accountSummary: buildAccountSummary(allActiveUsers),
      adminSeller: {
        courseCount: coursesByInstructorId.get(String(req.user.userId)) || 0,
        salesCount: adminSellerMetrics.salesCount,
        grossRevenue: toNumber(adminSellerMetrics.grossRevenue),
        netRevenue: toNumber(adminSellerMetrics.instructorRevenue),
        enrollments: instructorEnrollmentCounts.get(String(req.user.userId)) || 0,
      },
      payoutAccounts: {
        paymentSettings: serializeUserPaymentSettings(adminUser || {}),
        receivePlatformFeesInSameOwnerAccounts: true,
      },
      paymentProviders,
      topCourses,
      recentSales,
      sellers,
      accounts,
    });
  } catch (error) {
    console.error('Error fetching admin dashboard:', error);
    return res.status(500).json({
      error: error.message || 'Unable to fetch admin dashboard.',
    });
  }
});

router.get('/settings', authenticateToken, authorizeRoles('admin'), async (req, res) => {
  try {
    return res.json(await loadAdminSettingsSnapshot(req.user.userId));
  } catch (error) {
    console.error('Error fetching admin settings:', error);
    return res.status(500).json({
      error: error.message || 'Unable to fetch admin settings.',
    });
  }
});

router.put('/settings', authenticateToken, authorizeRoles('admin'), async (req, res) => {
  try {
    const settings = await updatePlatformSettings({
      platformFeePercent: req.body?.platformFeePercent,
      platformName: req.body?.platformName,
      supportEmail: req.body?.supportEmail,
      allowStudentRegistrations: req.body?.allowStudentRegistrations,
      allowInstructorRegistrations: req.body?.allowInstructorRegistrations,
      allowInstructorCreatorAccess: req.body?.allowInstructorCreatorAccess,
      allowInstructorPublicSales: req.body?.allowInstructorPublicSales,
      maintenanceMode: req.body?.maintenanceMode,
    });

    return res.json(
      await loadAdminSettingsSnapshot(req.user.userId, {
        settings,
      })
    );
  } catch (error) {
    console.error('Error updating admin settings:', error);
    return res.status(error.statusCode || 400).json({
      error: error.message || 'Unable to update admin settings.',
    });
  }
});

router.post('/instructor-mode', authenticateToken, authorizeRoles('admin'), async (req, res) => {
  try {
    const requestedEnabled = Boolean(req.body?.enabled);
    const [currentSettings, adminUser] = await Promise.all([
      getPlatformSettings(),
      User.findById(req.user.userId),
    ]);

    if (adminUser?.paymentSettings?.stripeConnect?.accountId) {
      await syncStripeConnectedAccount(adminUser);
    }

    const serializedCurrentSettings = serializePlatformSettings(currentSettings);
    const currentInstructorMode = getInstructorModeStatus(
      adminUser || {},
      serializedCurrentSettings
    );

    if (requestedEnabled && !currentInstructorMode.canEnable) {
      return res.status(400).json({
        error:
          currentInstructorMode.blockers[0] ||
          'Instructor mode is not ready yet. Finish Stripe or PayPal setup first.',
        instructorMode: currentInstructorMode,
      });
    }

    const updatedSettings = await updatePlatformSettings({
      ...serializedCurrentSettings,
      allowInstructorRegistrations: requestedEnabled,
      allowInstructorCreatorAccess: requestedEnabled,
      allowInstructorPublicSales: requestedEnabled,
    });

    return res.json({
      message: requestedEnabled
        ? 'Instructor mode is now enabled.'
        : 'Instructor mode is now disabled.',
      ...(await loadAdminSettingsSnapshot(req.user.userId, {
        settings: updatedSettings,
      })),
    });
  } catch (error) {
    console.error('Error toggling instructor mode:', error);
    return res.status(error.statusCode || 400).json({
      error: error.message || 'Unable to toggle instructor mode.',
    });
  }
});

router.get('/payment-settings', authenticateToken, authorizeRoles('admin'), async (req, res) => {
  try {
    const settings = await getPlatformSettings();
    return res.json({
      settings: serializePlatformSettings(settings),
    });
  } catch (error) {
    console.error('Error fetching admin payment settings:', error);
    return res.status(500).json({
      error: error.message || 'Unable to fetch payment settings.',
    });
  }
});

router.put('/payment-settings', authenticateToken, authorizeRoles('admin'), async (req, res) => {
  try {
    const settings = await updatePlatformPaymentSettings({
      platformFeePercent: req.body?.platformFeePercent,
    });

    return res.json({
      settings: serializePlatformSettings(settings),
    });
  } catch (error) {
    console.error('Error updating admin payment settings:', error);
    return res.status(error.statusCode || 400).json({
      error: error.message || 'Unable to update payment settings.',
    });
  }
});

router.post(
  '/payment-settings/stripe/onboarding-link',
  authenticateToken,
  authorizeRoles('admin'),
  async (req, res) => {
    try {
      const user = await User.findById(req.user.userId);
      if (!user) {
        return res.status(404).json({ error: 'Admin user not found.' });
      }

      const onboarding = await createStripeOnboardingLink(user, {
        refreshUrl: getAdminSettingsUrl({ stripe: 'refresh' }),
        returnUrl: getAdminSettingsUrl({ stripe: 'connected' }),
      });

      return res.json(onboarding);
    } catch (error) {
      console.error('Error creating admin Stripe onboarding link:', error);
      return res.status(error.statusCode || 500).json({
        error: error.message || 'Unable to start Stripe onboarding.',
      });
    }
  }
);

router.post(
  '/payment-settings/paypal/onboarding-link',
  authenticateToken,
  authorizeRoles('admin'),
  async (req, res) => {
    try {
      return res.status(400).json({
        error:
          'PayPal onboarding is no longer used here. PayPal now receives admin-owned revenue directly from the platform PayPal business account configured in the API, while instructors use Stripe only.',
      });
    } catch (error) {
      console.error('Error creating admin PayPal onboarding link:', error);
      return res.status(error.statusCode || 500).json({
        error: error.message || 'Unable to start PayPal onboarding.',
      });
    }
  }
);

router.put(
  '/users/bulk/status',
  authenticateToken,
  authorizeRoles('admin'),
  async (req, res) => {
    try {
      const { status, reason, userIds } = req.body || {};
      if (!['active', 'blocked'].includes(status)) {
        return res.status(400).json({
          error: 'Status must be either active or blocked.',
        });
      }

      const { users, skipped } = await collectBulkManageableUsers(userIds, req.user.userId);
      if (users.length === 0) {
        return res.status(400).json({
          error: skipped[0]?.reason || 'No eligible accounts found in the current selection.',
          skipped,
        });
      }

      await Promise.all(
        users.map(async (user) => {
          user.accountStatus = status;
          user.accountStatusReason =
            status === 'blocked' ? String(reason || '').trim() : undefined;
          user.accountStatusUpdatedAt = new Date();
          await user.save();
        })
      );

      return res.json({
        message:
          status === 'blocked'
            ? `${users.length} account(s) blocked.${skipped.length ? ` ${skipped.length} skipped.` : ''}`
            : `${users.length} account(s) reactivated.${skipped.length ? ` ${skipped.length} skipped.` : ''}`,
        updatedCount: users.length,
        skipped,
      });
    } catch (error) {
      console.error('Error updating bulk user status:', error);
      return res.status(error.statusCode || 400).json({
        error: error.message || 'Unable to update selected account statuses.',
      });
    }
  }
);

router.post(
  '/users/bulk/contact',
  authenticateToken,
  authorizeRoles('admin'),
  adminEmailUpload.fields([
    { name: 'attachments', maxCount: 8 },
    { name: 'inlineImages', maxCount: 12 },
  ]),
  async (req, res) => {
    try {
      const { userIds } = req.body || {};
      const { subject, message, messageHtml, attachments } = parseAdminEmailPayload(req);
      if (!subject || (!messageHtml.trim() && !String(message || '').trim())) {
        return res.status(400).json({
          error: 'Subject and email content are required.',
        });
      }

      const [{ users, skipped }, adminUser, settings] = await Promise.all([
        collectBulkManageableUsers(userIds, req.user.userId, {
          allowSelf: true,
          allowAdminRole: true,
          allowReservedAdmin: true,
        }),
        User.findById(req.user.userId).lean(),
        getPlatformSettings(),
      ]);

      if (users.length === 0) {
        return res.status(400).json({
          error: skipped[0]?.reason || 'No eligible accounts found in the current selection.',
          skipped,
        });
      }

      const serializedSettings = serializePlatformSettings(settings);
      const emailResults = await Promise.all(
        users.map(async (targetUser) => {
          const result = await sendEmail({
            to: targetUser.email,
            subject: String(subject).trim(),
            html: getAdminContactEmailTemplate({
              platformName: serializedSettings.platformName,
              recipientName: getDisplayName(targetUser),
              adminName: getDisplayName(adminUser || {}),
              subject,
              message: String(message || '').trim(),
              messageHtml,
              supportEmail: serializedSettings.supportEmail,
            }),
            attachments,
          });

          return {
            userId: String(targetUser._id),
            email: targetUser.email,
            success: result.success,
            error: result.error || null,
          };
        })
      );

      const sent = emailResults.filter((result) => result.success);
      const failed = emailResults.filter((result) => !result.success);

      if (sent.length === 0) {
        return res.status(500).json({
          error: failed[0]?.error || 'Unable to send bulk email.',
          failed,
          skipped,
        });
      }

      return res.json({
        message: `${sent.length} email(s) sent.${failed.length ? ` ${failed.length} failed.` : ''}${skipped.length ? ` ${skipped.length} skipped.` : ''}`,
        sentCount: sent.length,
        failed,
        skipped,
      });
    } catch (error) {
      console.error('Error sending bulk admin email:', error);
      return res.status(error.statusCode || 400).json({
        error: error.message || 'Unable to send bulk email.',
      });
    }
  }
);

router.put('/users/:userId/status', authenticateToken, authorizeRoles('admin'), async (req, res) => {
  try {
    const { status, reason } = req.body || {};
    if (!['active', 'blocked'].includes(status)) {
      return res.status(400).json({
        error: 'Status must be either active or blocked.',
      });
    }

    const user = await getManageableUserOrThrow(req.params.userId, req.user.userId);
    user.accountStatus = status;
    user.accountStatusReason = status === 'blocked' ? String(reason || '').trim() : undefined;
    user.accountStatusUpdatedAt = new Date();
    await user.save();

    return res.json({
      message:
        status === 'blocked'
          ? 'Account blocked successfully.'
          : 'Account reactivated successfully.',
      user: {
        userId: String(user._id),
        accountStatus: user.accountStatus,
        accountStatusReason: user.accountStatusReason || '',
      },
    });
  } catch (error) {
    console.error('Error updating user status:', error);
    return res.status(error.statusCode || 400).json({
      error: error.message || 'Unable to update account status.',
    });
  }
});

router.put(
  '/users/:userId/commission',
  authenticateToken,
  authorizeRoles('admin'),
  async (req, res) => {
    try {
      const user = await getManageableUserOrThrow(req.params.userId, req.user.userId, {
        allowDeleted: false,
      });

      if (user.role === 'admin') {
        return res.status(400).json({
          error: 'Admin-owned courses always use 0% platform fee and do not need a custom override.',
        });
      }

      const rawValue = req.body?.customPlatformFeePercent;
      user.customPlatformFeePercent =
        rawValue === null || rawValue === undefined || rawValue === ''
          ? null
          : normalizePlatformFeePercent(rawValue, 0);
      await user.save();

      const settings = serializePlatformSettings(await getPlatformSettings());

      return res.json({
        message:
          user.customPlatformFeePercent === null
            ? 'Custom commission removed. This account now uses the default platform fee.'
            : 'Custom commission saved successfully.',
        user: {
          userId: String(user._id),
          customPlatformFeePercent: user.customPlatformFeePercent,
          effectivePlatformFeePercent: getEffectivePlatformFeePercent(
            user,
            settings.platformFeePercent
          ),
        },
      });
    } catch (error) {
      console.error('Error updating custom commission:', error);
      return res.status(error.statusCode || 400).json({
        error: error.message || 'Unable to update custom commission.',
      });
    }
  }
);

router.post(
  '/users/:userId/contact',
  authenticateToken,
  authorizeRoles('admin'),
  adminEmailUpload.fields([
    { name: 'attachments', maxCount: 8 },
    { name: 'inlineImages', maxCount: 12 },
  ]),
  async (req, res) => {
    try {
      const { subject, message, messageHtml, attachments } = parseAdminEmailPayload(req);
      if (!subject || (!messageHtml.trim() && !String(message || '').trim())) {
        return res.status(400).json({
          error: 'Subject and email content are required.',
        });
      }

      const [targetUser, adminUser, settings] = await Promise.all([
        getManageableUserOrThrow(req.params.userId, req.user.userId, {
          allowSelf: true,
          allowAdminRole: true,
          allowReservedAdmin: true,
        }),
        User.findById(req.user.userId).lean(),
        getPlatformSettings(),
      ]);

      const serializedSettings = serializePlatformSettings(settings);
      const result = await sendEmail({
        to: targetUser.email,
        subject,
        html: getAdminContactEmailTemplate({
          platformName: serializedSettings.platformName,
          recipientName: getDisplayName(targetUser),
          adminName: getDisplayName(adminUser || {}),
          subject,
          message: String(message || '').trim(),
          messageHtml,
          supportEmail: serializedSettings.supportEmail,
        }),
        attachments,
      });

      if (!result.success) {
        const error = new Error(result.error || 'Unable to send email.');
        error.statusCode = 500;
        throw error;
      }

      return res.json({
        message: `Email sent successfully to ${targetUser.email}.`,
      });
    } catch (error) {
      console.error('Error contacting user:', error);
      return res.status(error.statusCode || 400).json({
        error: error.message || 'Unable to send email.',
      });
    }
  }
);

router.post(
  '/users/:userId/reset-password',
  authenticateToken,
  authorizeRoles('admin'),
  async (req, res) => {
    try {
      const user = await getManageableUserOrThrow(req.params.userId, req.user.userId, {
        allowSelf: true,
        allowAdminRole: true,
        allowReservedAdmin: true,
      });

      const { resetUrl } = await sendPasswordResetEmail(user);
      console.log('ADMIN PASSWORD RESET TRIGGERED', {
        targetUser: user.email,
        resetUrl,
      });

      return res.json({
        message: `Password reset email sent to ${user.email}.`,
      });
    } catch (error) {
      console.error('Error sending admin password reset:', error);
      return res.status(error.statusCode || 400).json({
        error: error.message || 'Unable to send password reset email.',
      });
    }
  }
);

router.delete('/users/:userId', authenticateToken, authorizeRoles('admin'), async (req, res) => {
  try {
    const user = await getManageableUserOrThrow(req.params.userId, req.user.userId);
    const blockers = await getDeletionBlockers(user._id);

    if (blockers.length > 0) {
      return res.status(400).json({
        error: `This account cannot be deleted yet because it still has related data: ${blockers.join(
          ', '
        )}. Block the account instead if you want to disable access.`,
      });
    }

    await User.findByIdAndDelete(user._id);

    return res.json({
      message: `Account ${user.email} deleted permanently.`,
    });
  } catch (error) {
    console.error('Error deleting user account:', error);
    return res.status(error.statusCode || 400).json({
      error: error.message || 'Unable to delete account.',
    });
  }
});

module.exports = router;
