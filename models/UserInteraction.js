const mongoose = require('mongoose');

const UserInteractionSchema = new mongoose.Schema(
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
    interactionType: {
      type: String,
      enum: ['view', 'enroll', 'complete', 'like', 'rating'],
      required: true,
    },
    rating: {
      type: Number,
      min: 1,
      max: 5,
    },
  },
  {
    timestamps: true,
  }
);

UserInteractionSchema.index({ userId: 1, courseId: 1, interactionType: 1 }, { unique: true });

const UserInteraction = mongoose.models.UserInteraction || mongoose.model('UserInteraction', UserInteractionSchema);

module.exports = UserInteraction;
