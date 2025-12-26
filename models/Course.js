const mongoose = require('mongoose');

const CourseSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: [true, 'Course title is required'],
      trim: true,
    },
    description: {
      type: String,
      required: [true, 'Course description is required'],
      trim: true,
    },
    categoryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Category',
      required: true,
    },
    instructorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    price: {
      type: Number,
      default: 0,
    },
    thumbnail: {
      type: String,
    },
    status: {
      type: String,
      enum: ['draft', 'published'],
      default: 'draft',
    },
    modules: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Module',
    }],
    finalExam: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Quiz',
    },
  },
  {
    timestamps: true,
  }
);

const Course = mongoose.models.Course || mongoose.model('Course', CourseSchema);

module.exports = Course;
