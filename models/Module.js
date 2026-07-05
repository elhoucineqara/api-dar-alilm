const mongoose = require('mongoose');

const ModuleSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: [true, 'Module title is required'],
      trim: true,
    },
    description: {
      type: String,
      trim: true,
    },
    courseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Course',
      required: true,
    },
    order: {
      type: Number,
      required: true,
      default: 0,
    },
    sections: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Section',
    }],
    quiz: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Quiz',
    },
  },
  {
    timestamps: true,
  }
);

const Module = mongoose.models.Module || mongoose.model('Module', ModuleSchema);

module.exports = Module;
