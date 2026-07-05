const mongoose = require('mongoose');

const PlatformSettingsSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      default: 'default',
      trim: true,
    },
    payment: {
      platformFeePercent: {
        type: Number,
        default: 20,
        min: 0,
        max: 100,
      },
    },
    general: {
      platformName: {
        type: String,
        trim: true,
        default: 'QaraNetwork',
      },
      supportEmail: {
        type: String,
        trim: true,
        lowercase: true,
        default: 'mohamedqara@gmail.com',
      },
    },
    access: {
      allowStudentRegistrations: {
        type: Boolean,
        default: true,
      },
      allowInstructorRegistrations: {
        type: Boolean,
        default: false,
      },
      allowInstructorCreatorAccess: {
        type: Boolean,
        default: false,
      },
      allowInstructorPublicSales: {
        type: Boolean,
        default: false,
      },
      maintenanceMode: {
        type: Boolean,
        default: false,
      },
    },
  },
  {
    timestamps: true,
  }
);

const PlatformSettings =
  mongoose.models.PlatformSettings ||
  mongoose.model('PlatformSettings', PlatformSettingsSchema);

module.exports = PlatformSettings;
