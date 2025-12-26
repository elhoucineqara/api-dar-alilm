const mongoose = require('mongoose');

const ReplySchema = new mongoose.Schema(
  {
    content: {
      type: String,
      required: true,
      trim: true,
      maxlength: 5000,
    },
    authorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    likes: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    }],
  },
  {
    timestamps: true,
  }
);

const ForumPostSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: false,
      trim: true,
      maxlength: 200,
    },
    content: {
      type: String,
      required: [true, 'Content is required'],
      trim: true,
      maxlength: 5000,
    },
    category: {
      type: String,
      enum: ['general', 'courses', 'technical', 'assignments', 'help'],
      default: 'general',
    },
    authorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    courseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Course',
      index: true,
    },
    likes: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    }],
    replies: [ReplySchema],
    views: {
      type: Number,
      default: 0,
    },
    isPinned: {
      type: Boolean,
      default: false,
    },
    media: [{
      type: {
        type: String,
        enum: ['image', 'video'],
        required: true,
      },
      url: {
        type: String,
        required: true,
      },
      thumbnail: String, // Pour les vidéos
    }],
  },
  {
    timestamps: true,
  }
);

ForumPostSchema.index({ createdAt: -1 });
ForumPostSchema.index({ category: 1 });
ForumPostSchema.index({ isPinned: -1, createdAt: -1 });

const ForumPost = mongoose.models.ForumPost || mongoose.model('ForumPost', ForumPostSchema);

module.exports = ForumPost;
