const mongoose = require('mongoose');

const QuestionSchema = new mongoose.Schema(
  {
    question: {
      type: String,
      required: [true, 'Question text is required'],
      trim: true,
    },
    type: {
      type: String,
      enum: [
        'qcm',
        'true_false',
        'multiple_correct',
        'single_choice',
        'sequence',
        'drag_drop',
        'quiz_image',
        'matching',
        'fill_blank',
      ],
      required: true,
    },
    quizId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Quiz',
      required: true,
    },
    order: {
      type: Number,
      required: true,
      default: 0,
    },
    points: {
      type: Number,
      required: true,
      default: 1,
    },
    imageId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'File',
    },
    imageUrl: {
      type: String,
      trim: true,
    },
    imageName: {
      type: String,
      trim: true,
    },
    answers: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Answer',
    }],
  },
  {
    timestamps: true,
  }
);

const Question = mongoose.models.Question || mongoose.model('Question', QuestionSchema);

module.exports = Question;
