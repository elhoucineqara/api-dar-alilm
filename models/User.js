const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const PayPalProductSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      trim: true,
    },
    status: {
      type: String,
      trim: true,
    },
    vettingStatus: {
      type: String,
      trim: true,
    },
  },
  { _id: false }
);

const StripeConnectSchema = new mongoose.Schema(
  {
    accountId: {
      type: String,
      trim: true,
    },
    chargesEnabled: {
      type: Boolean,
      default: false,
    },
    payoutsEnabled: {
      type: Boolean,
      default: false,
    },
    detailsSubmitted: {
      type: Boolean,
      default: false,
    },
    onboardingComplete: {
      type: Boolean,
      default: false,
    },
    connectedAt: {
      type: Date,
    },
    lastSyncedAt: {
      type: Date,
    },
  },
  { _id: false }
);

const PayPalMerchantSchema = new mongoose.Schema(
  {
    trackingId: {
      type: String,
      trim: true,
    },
    merchantId: {
      type: String,
      trim: true,
    },
    merchantEmail: {
      type: String,
      lowercase: true,
      trim: true,
    },
    accountStatus: {
      type: String,
      trim: true,
    },
    onboardingStatus: {
      type: String,
      enum: ['not_started', 'pending', 'linked', 'needs_attention'],
      default: 'not_started',
    },
    permissionsGranted: {
      type: Boolean,
      default: false,
    },
    paymentsReceivable: {
      type: Boolean,
      default: false,
    },
    primaryEmailConfirmed: {
      type: Boolean,
      default: false,
    },
    products: {
      type: [PayPalProductSchema],
      default: [],
    },
    frontendReturnPath: {
      type: String,
      trim: true,
    },
    connectedAt: {
      type: Date,
    },
    lastSyncedAt: {
      type: Date,
    },
  },
  { _id: false }
);

const PaymentSettingsSchema = new mongoose.Schema(
  {
    preferredProvider: {
      type: String,
      enum: ['stripe', 'paypal', null],
      default: null,
    },
    stripeCustomerId: {
      type: String,
      trim: true,
    },
    paypalCustomerId: {
      type: String,
      trim: true,
    },
    stripeConnect: {
      type: StripeConnectSchema,
      default: () => ({}),
    },
    paypalMerchant: {
      type: PayPalMerchantSchema,
      default: () => ({}),
    },
  },
  { _id: false }
);

const UserSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, 'Please provide a valid email'],
    },
    password: {
      type: String,
      required: function () {
        return !this.googleId;
      },
      minlength: [6, 'Password must be at least 6 characters'],
    },
    googleId: {
      type: String,
      unique: true,
      sparse: true,
      trim: true,
    },
    firstName: {
      type: String,
      required: [true, 'First name is required'],
      trim: true,
    },
    lastName: {
      type: String,
      required: [true, 'Last name is required'],
      trim: true,
    },
    role: {
      type: String,
      enum: ['student', 'instructor', 'admin'],
      default: 'student',
      required: true,
    },
    accountStatus: {
      type: String,
      enum: ['active', 'blocked', 'deleted'],
      default: 'active',
      required: true,
    },
    accountStatusReason: {
      type: String,
      trim: true,
      maxlength: 300,
    },
    accountStatusUpdatedAt: {
      type: Date,
    },
    customPlatformFeePercent: {
      type: Number,
      min: 0,
      max: 100,
      default: null,
    },
    phone: {
      type: String,
      trim: true,
    },
    bio: {
      type: String,
      maxlength: 500,
    },
    profileImage: {
      type: String,
    },
    paymentSettings: {
      type: PaymentSettingsSchema,
      default: () => ({}),
    },
    resetPasswordToken: {
      type: String,
      required: false,
    },
    resetPasswordExpires: {
      type: Date,
      required: false,
    },
  },
  {
    timestamps: true,
  }
);

// Hash password before saving
UserSchema.pre('save', async function () {
  if (!this.password || !this.isModified('password')) {
    return;
  }

  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
  } catch (error) {
    throw error;
  }
});

// Method to compare password
UserSchema.methods.comparePassword = async function (candidatePassword) {
  if (!this.password) {
    return false;
  }

  return bcrypt.compare(candidatePassword, this.password);
};

// Prevent password from being returned in JSON
UserSchema.methods.toJSON = function () {
  const obj = this.toObject();
  delete obj.password;
  return obj;
};

const User = mongoose.models.User || mongoose.model('User', UserSchema);

module.exports = User;
