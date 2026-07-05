const mongoose = require('mongoose');

const CoursePaymentSchema = new mongoose.Schema(
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
    instructorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: false,
      index: true,
    },
    enrollmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Enrollment',
      required: false,
      index: true,
    },
    provider: {
      type: String,
      enum: ['stripe', 'paypal'],
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ['pending', 'completed', 'failed', 'cancelled'],
      default: 'pending',
      index: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    platformFeePercent: {
      type: Number,
      min: 0,
      max: 100,
    },
    platformFeeAmount: {
      type: Number,
      min: 0,
    },
    instructorAmount: {
      type: Number,
      min: 0,
    },
    currency: {
      type: String,
      default: 'USD',
      uppercase: true,
      trim: true,
    },
    externalCheckoutId: {
      type: String,
      sparse: true,
      trim: true,
    },
    externalPaymentId: {
      type: String,
      sparse: true,
      trim: true,
    },
    paidAt: {
      type: Date,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
  }
);

CoursePaymentSchema.index({ externalCheckoutId: 1 }, { unique: true, sparse: true });
CoursePaymentSchema.index({ externalPaymentId: 1 }, { unique: true, sparse: true });

const CoursePayment =
  mongoose.models.CoursePayment || mongoose.model('CoursePayment', CoursePaymentSchema);

module.exports = CoursePayment;
