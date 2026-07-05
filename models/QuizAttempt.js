const mongoose = require('mongoose');

const QuizAttemptSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    quizId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Quiz',
      required: true,
      index: true,
    },
    courseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Course',
      required: true,
      index: true,
    },
    moduleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Module',
    },
    isFinalExam: {
      type: Boolean,
      default: false,
    },
    answers: [
      {
        questionId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'Question',
          required: true,
        },
        answerIds: [
          {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Answer',
          },
        ],
        textAnswer: {
          type: String,
          trim: true,
        },
        correct: {
          type: Boolean,
          default: false,
        },
        pointsAwarded: {
          type: Number,
          default: 0,
        },
        pointsPossible: {
          type: Number,
          default: 0,
        },
      },
    ],
    score: {
      type: Number,
      required: true,
      min: 0,
      max: 100,
    },
    pointsAwarded: {
      type: Number,
      default: 0,
    },
    pointsPossible: {
      type: Number,
      default: 0,
    },
    passed: {
      type: Boolean,
      default: false,
    },
    submittedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

const QuizAttempt =
  mongoose.models.QuizAttempt || mongoose.model('QuizAttempt', QuizAttemptSchema);

module.exports = QuizAttempt;
