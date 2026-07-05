const User = require('../models/User');
const { getPlatformSettings, serializePlatformSettings } = require('./platform-settings');
const { requireAuthUser } = require('./request-auth');

function normalizeCreatorSettings(settings) {
  return settings?.allowStudentRegistrations !== undefined
    ? settings
    : serializePlatformSettings(settings);
}

function canUserAccessCreatorWorkspace(userOrRole, settings) {
  const role = typeof userOrRole === 'string' ? userOrRole : userOrRole?.role;
  const accountStatus =
    typeof userOrRole === 'object' && userOrRole ? userOrRole.accountStatus : undefined;
  const normalizedSettings = normalizeCreatorSettings(settings);

  if (accountStatus && accountStatus !== 'active') {
    return false;
  }

  if (role === 'admin') {
    return true;
  }

  return role === 'instructor' && normalizedSettings.allowInstructorCreatorAccess;
}

function canUserSellCoursesPublicly(userOrRole, settings) {
  const role = typeof userOrRole === 'string' ? userOrRole : userOrRole?.role;
  const accountStatus =
    typeof userOrRole === 'object' && userOrRole ? userOrRole.accountStatus : undefined;
  const normalizedSettings = normalizeCreatorSettings(settings);

  if (accountStatus && accountStatus !== 'active') {
    return false;
  }

  if (role === 'admin') {
    return true;
  }

  return role === 'instructor' && normalizedSettings.allowInstructorPublicSales;
}

async function requireCreatorUser(req, res, next) {
  try {
    const authUser = await requireAuthUser(req);
    const settings = serializePlatformSettings(await getPlatformSettings());

    if (!canUserAccessCreatorWorkspace(authUser, settings)) {
      return res.status(403).json({
        error:
          authUser.role === 'instructor'
            ? 'Instructor creator access is currently disabled. Only the admin can manage courses and sales right now.'
            : 'Forbidden',
      });
    }

    req.user = authUser;
    req.platformAccess = settings;
    return next();
  } catch (error) {
    return res.status(error.statusCode || 401).json({
      error: error.message || 'Unauthorized',
    });
  }
}

function assertUserCanPublishCoursePublicly(userOrRole, settings) {
  if (canUserSellCoursesPublicly(userOrRole, settings)) {
    return true;
  }

  const error = new Error(
    'Instructor public course publishing is currently disabled. Only the admin can publish and sell courses publicly right now.'
  );
  error.statusCode = 403;
  throw error;
}

async function getPublicSellerIds(settings) {
  const normalizedSettings = normalizeCreatorSettings(settings);
  const roles = normalizedSettings.allowInstructorPublicSales
    ? ['admin', 'instructor']
    : ['admin'];

  return User.find({
    role: { $in: roles },
    $or: [{ accountStatus: 'active' }, { accountStatus: { $exists: false } }],
  }).distinct('_id');
}

async function getPublicCourseQuery(settings) {
  const publicSellerIds = await getPublicSellerIds(settings);

  return {
    status: 'published',
    enrollmentOpen: { $ne: false },
    instructorId: {
      $in: publicSellerIds,
    },
  };
}

async function getCourseOwnerForPublicAccess(course, ownerOverride) {
  if (ownerOverride) {
    return ownerOverride;
  }

  const populatedInstructor = course?.instructorId;
  if (
    populatedInstructor &&
    typeof populatedInstructor === 'object' &&
    populatedInstructor.role
  ) {
    return populatedInstructor;
  }

  if (!course?.instructorId) {
    return null;
  }

  return User.findById(course.instructorId)
    .select('role accountStatus firstName lastName email profileImage paymentSettings')
    .lean();
}

async function isCoursePubliclyVisible(course, options = {}) {
  if (!course || course.status !== 'published') {
    return false;
  }

  if (options.requireEnrollmentOpen !== false && course.enrollmentOpen === false) {
    return false;
  }

  const settings = normalizeCreatorSettings(
    options.settings || (await getPlatformSettings())
  );
  const owner = await getCourseOwnerForPublicAccess(course, options.owner);

  return canUserSellCoursesPublicly(owner, settings);
}

async function assertCourseIsPubliclyVisible(course, options = {}) {
  const isVisible = await isCoursePubliclyVisible(course, options);
  if (isVisible) {
    return true;
  }

  const error = new Error('Course not found.');
  error.statusCode = 404;
  throw error;
}

module.exports = {
  assertCourseIsPubliclyVisible,
  assertUserCanPublishCoursePublicly,
  canUserAccessCreatorWorkspace,
  canUserSellCoursesPublicly,
  getPublicCourseQuery,
  requireCreatorUser,
};
