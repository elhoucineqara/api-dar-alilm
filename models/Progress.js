const mongoose = require('mongoose');

const ProgressSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    courseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Course',
      required: true,
      index: true,
    },
    enrollmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Enrollment',
      required: true,
      index: true,
    },
    moduleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Module',
    },
    sectionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Section',
    },
    quizId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Quiz',
    },
    completedSections: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Section',
    }],
    completedQuizzes: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Quiz',
    }],
    completedFinalExam: {
      type: Boolean,
      default: false,
    },
    overallProgress: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
      set: (v) => Math.min(v, 100),
    },
    lastAccessedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

ProgressSchema.index({ userId: 1, courseId: 1 }, { unique: true });

const Progress = mongoose.models.Progress || mongoose.model('Progress', ProgressSchema);

module.exports = Progress;
