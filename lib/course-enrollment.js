const Enrollment = require('../models/Enrollment');
const Progress = require('../models/Progress');

async function ensureEnrollmentAndProgress({ userId, courseId }) {
  let enrollment = await Enrollment.findOne({ userId, courseId });

  if (!enrollment) {
    try {
      enrollment = await Enrollment.create({
        userId,
        courseId,
        enrolledAt: new Date(),
        status: 'active',
      });
    } catch (error) {
      if (error && error.code === 11000) {
        enrollment = await Enrollment.findOne({ userId, courseId });
      } else {
        throw error;
      }
    }
  }

  let progress = await Progress.findOne({ userId, courseId });

  if (!progress) {
    try {
      progress = await Progress.create({
        userId,
        courseId,
        enrollmentId: enrollment._id,
        completedSections: [],
        completedQuizzes: [],
        completedFinalExam: false,
        overallProgress: 0,
        lastAccessedAt: new Date(),
      });
    } catch (error) {
      if (error && error.code === 11000) {
        progress = await Progress.findOne({ userId, courseId });
      } else {
        throw error;
      }
    }
  } else if (String(progress.enrollmentId) !== String(enrollment._id)) {
    progress.enrollmentId = enrollment._id;
    await progress.save();
  }

  return { enrollment, progress };
}

module.exports = {
  ensureEnrollmentAndProgress,
};
