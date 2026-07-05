const mongoose = require('mongoose');

const AboutSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: [true, 'Title is required'],
      trim: true,
    },
    subtitle: {
      type: String,
      trim: true,
    },
    description: {
      type: String,
      required: [true, 'Description is required'],
      trim: true,
    },
    mission: {
      type: String,
      trim: true,
    },
    vision: {
      type: String,
      trim: true,
    },
    values: [{
      title: {
        type: String,
        required: true,
      },
      description: {
        type: String,
        required: true,
      },
      icon: {
        type: String,
      },
    }],
    team: [{
      name: {
        type: String,
        required: true,
      },
      role: {
        type: String,
        required: true,
      },
      bio: {
        type: String,
      },
      image: {
        type: String,
      },
      social: {
        linkedin: String,
        twitter: String,
        email: String,
      },
    }],
    stats: [{
      label: {
        type: String,
        required: true,
      },
      value: {
        type: String,
        required: true,
      },
      icon: {
        type: String,
      },
    }],
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('About', AboutSchema);

