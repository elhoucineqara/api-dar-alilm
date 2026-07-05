const mongoose = require('mongoose');

const AnswerSchema = new mongoose.Schema(
  {
    answer: {
      type: String,
      required: [true, 'Answer text is required'],
      trim: true,
    },
    matchText: {
      type: String,
      trim: true,
    },
    questionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Question',
      required: true,
    },
    isCorrect: {
      type: Boolean,
      required: true,
      default: false,
    },
    order: {
      type: Number,
      required: true,
      default: 0,
    },
  },
  {
    timestamps: true,
  }
);

const Answer = mongoose.models.Answer || mongoose.model('Answer', AnswerSchema);

module.exports = Answer;
