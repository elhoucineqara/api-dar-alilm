const Enrollment = require('../models/Enrollment');

function isPaidCourse(course) {
  return Boolean(course?.price && course.price > 0);
}

function getUserId(user) {
  return String(user?.userId || user?.id || '').trim();
}

async function userCanAccessCourse({ user, course }) {
  if (!course) {
    return false;
  }

  const userId = getUserId(user);
  const isPublishedCourse = course.status === 'published';
  const isEnrollmentOpen = course.enrollmentOpen !== false;

  if (!isPaidCourse(course) && isPublishedCourse && isEnrollmentOpen && userId) {
    return true;
  }

  if (!userId) {
    return false;
  }

  if (user.role === 'admin') {
    return true;
  }

  if (user.role === 'instructor') {
    const instructorId = course.instructorId?._id || course.instructorId;
    return String(instructorId) === userId;
  }

  if (user.role !== 'student') {
    return false;
  }

  const enrollment = await Enrollment.findOne({
    userId,
    courseId: course._id,
  })
    .select('_id')
    .lean();

  return Boolean(enrollment);
}

module.exports = {
  isPaidCourse,
  userCanAccessCourse,
};
