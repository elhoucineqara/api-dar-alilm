const mongoose = require('mongoose');

const SectionSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: [true, 'Section title is required'],
      trim: true,
    },
    description: {
      type: String,
      trim: true,
    },
    moduleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Module',
      required: true,
    },
    type: {
      type: String,
      enum: ['file', 'youtube', 'video', 'article', 'quiz'],
      required: true,
    },
    order: {
      type: Number,
      required: true,
      default: 0,
    },
    fileId: {
      type: String,
    },
    fileUrl: {
      type: String,
    },
    fileName: {
      type: String,
    },
    fileType: {
      type: String,
      enum: ['pdf', 'word', 'ppt', 'video'],
    },
    youtubeUrl: {
      type: String,
    },
    articleContent: {
      type: String,
      trim: true,
    },
    quizId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Quiz',
    },
  },
  {
    timestamps: true,
  }
);

const Section = mongoose.models.Section || mongoose.model('Section', SectionSchema);

module.exports = Section;
