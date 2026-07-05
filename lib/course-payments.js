const Stripe = require('stripe');

const Course = require('../models/Course');
const CoursePayment = require('../models/CoursePayment');
const Enrollment = require('../models/Enrollment');
const User = require('../models/User');
const { assertCourseIsPubliclyVisible } = require('./creator-access');
const { ensureEnrollmentAndProgress } = require('./course-enrollment');
const { isPaidCourse } = require('./course-access');
const { getInstructorPaymentProviderAvailability } = require('./user-payment-settings');

function getFrontendUrl() {
  return (
    process.env.FRONTEND_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    'http://localhost:3000'
  ).replace(/\/+$/, '');
}

function getPaymentCurrency() {
  return (process.env.PAYMENT_CURRENCY || 'USD').toUpperCase();
}

function getStripeClient() {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    throw new Error('STRIPE_SECRET_KEY is required for Stripe payments.');
  }

  return new Stripe(secretKey);
}

function getStripeWebhookSecret() {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    throw new Error('STRIPE_WEBHOOK_SECRET is required for Stripe webhooks.');
  }

  return webhookSecret;
}

function normalizeAmount(amount) {
  return Number(Number(amount || 0).toFixed(2));
}

function normalizePercent(percent) {
  if (percent === undefined || percent === null || percent === '') {
    return undefined;
  }

  const parsed = Number(percent);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }

  if (parsed < 0) {
    return 0;
  }

  if (parsed > 100) {
    return 100;
  }

  return Number(parsed.toFixed(2));
}

function toStripeUnitAmount(amount) {
  return Math.round(normalizeAmount(amount) * 100);
}

async function getPurchaseContext({ courseId, userId }) {
  const [course, user, existingCompletedPayment, existingEnrollment] = await Promise.all([
    Course.findById(courseId),
    User.findById(userId).select('email firstName lastName role accountStatus').lean(),
    CoursePayment.findOne({
      courseId,
      userId,
      status: 'completed',
    }).lean(),
    Enrollment.findOne({
      courseId,
      userId,
    }).select('_id').lean(),
  ]);

  if (!course || course.status !== 'published') {
    const error = new Error('Course not found.');
    error.statusCode = 404;
    throw error;
  }

  if (!user) {
    const error = new Error('User not found.');
    error.statusCode = 404;
    throw error;
  }

  const instructor = await User.findById(course.instructorId)
    .select('email firstName lastName role paymentSettings customPlatformFeePercent accountStatus')
    .lean();

  if (!instructor) {
    const error = new Error('Instructor not found.');
    error.statusCode = 404;
    throw error;
  }

  await assertCourseIsPubliclyVisible(course, { owner: instructor });

  if (instructor.accountStatus && instructor.accountStatus !== 'active') {
    const error = new Error('This course cannot be purchased right now because the instructor account is unavailable.');
    error.statusCode = 403;
    throw error;
  }

  if (user.role !== 'student') {
    const error = new Error('Only student accounts can purchase courses.');
    error.statusCode = 403;
    throw error;
  }

  if (!isPaidCourse(course)) {
    const error = new Error('This course is free and does not require payment.');
    error.statusCode = 400;
    throw error;
  }

  if (String(course.instructorId) === String(userId)) {
    const error = new Error('You already own this course as its instructor.');
    error.statusCode = 400;
    throw error;
  }

  if (existingCompletedPayment || existingEnrollment) {
    return {
      course,
      user,
      alreadyPurchased: true,
      payment: existingCompletedPayment,
    };
  }

  return {
    course,
    user,
    instructor,
    instructorPaymentProviders: getInstructorPaymentProviderAvailability(instructor),
    alreadyPurchased: false,
    payment: null,
  };
}

async function createPendingCoursePayment({
  userId,
  courseId,
  instructorId,
  provider,
  amount,
  currency,
  platformFeePercent,
  platformFeeAmount,
  instructorAmount,
  metadata = {},
}) {
  return CoursePayment.create({
    userId,
    courseId,
    instructorId,
    provider,
    status: 'pending',
    amount: normalizeAmount(amount),
    platformFeePercent: normalizePercent(platformFeePercent),
    platformFeeAmount:
      platformFeeAmount !== undefined ? normalizeAmount(platformFeeAmount) : undefined,
    instructorAmount:
      instructorAmount !== undefined ? normalizeAmount(instructorAmount) : undefined,
    currency: (currency || getPaymentCurrency()).toUpperCase(),
    metadata,
  });
}

async function markCoursePaymentStatus({
  provider,
  externalCheckoutId,
  externalPaymentId,
  status,
  metadata = {},
}) {
  const payment = await findCoursePaymentByExternalIds({
    provider,
    externalCheckoutId,
    externalPaymentId,
  });

  if (!payment) {
    return null;
  }

  payment.status = status;
  payment.metadata = {
    ...(payment.metadata || {}),
    ...metadata,
  };
  await payment.save();

  return payment;
}

async function findCoursePaymentByExternalIds({
  provider,
  externalCheckoutId,
  externalPaymentId,
  internalPaymentId,
}) {
  const or = [];

  if (internalPaymentId) {
    or.push({ _id: internalPaymentId });
  }
  if (externalCheckoutId) {
    or.push({ externalCheckoutId });
  }
  if (externalPaymentId) {
    or.push({ externalPaymentId });
  }

  if (or.length === 0) {
    return null;
  }

  return CoursePayment.findOne({
    provider,
    $or: or,
  });
}

async function finalizeCoursePayment({
  provider,
  courseId,
  userId,
  instructorId,
  internalPaymentId,
  externalCheckoutId,
  externalPaymentId,
  amount,
  currency,
  platformFeePercent,
  platformFeeAmount,
  instructorAmount,
  metadata = {},
  paidAt,
}) {
  let payment = await findCoursePaymentByExternalIds({
    provider,
    internalPaymentId,
    externalCheckoutId,
    externalPaymentId,
  });

  if (!payment) {
    payment = await CoursePayment.create({
      userId,
      courseId,
      instructorId,
      provider,
      status: 'pending',
      amount: normalizeAmount(amount),
      platformFeePercent: normalizePercent(platformFeePercent),
      platformFeeAmount:
        platformFeeAmount !== undefined ? normalizeAmount(platformFeeAmount) : undefined,
      instructorAmount:
        instructorAmount !== undefined ? normalizeAmount(instructorAmount) : undefined,
      currency: (currency || getPaymentCurrency()).toUpperCase(),
      externalCheckoutId,
      externalPaymentId,
      metadata,
    });
  }

  if (payment.status === 'completed' && payment.enrollmentId) {
    return payment;
  }

  const { enrollment } = await ensureEnrollmentAndProgress({
    userId: payment.userId,
    courseId: payment.courseId,
  });

  payment.status = 'completed';
  payment.instructorId = instructorId || payment.instructorId;
  payment.externalCheckoutId = externalCheckoutId || payment.externalCheckoutId;
  payment.externalPaymentId = externalPaymentId || payment.externalPaymentId;
  payment.amount = normalizeAmount(amount || payment.amount);
  payment.platformFeePercent =
    normalizePercent(platformFeePercent) ?? payment.platformFeePercent;
  payment.platformFeeAmount =
    platformFeeAmount !== undefined
      ? normalizeAmount(platformFeeAmount)
      : payment.platformFeeAmount;
  payment.instructorAmount =
    instructorAmount !== undefined ? normalizeAmount(instructorAmount) : payment.instructorAmount;
  payment.currency = (currency || payment.currency || getPaymentCurrency()).toUpperCase();
  payment.enrollmentId = enrollment._id;
  payment.paidAt = paidAt || payment.paidAt || new Date();
  payment.metadata = {
    ...(payment.metadata || {}),
    ...metadata,
  };

  await payment.save();

  return payment;
}

function getStudentCourseRedirect(courseId) {
  return `/student/courses/${courseId}`;
}

module.exports = {
  createPendingCoursePayment,
  finalizeCoursePayment,
  findCoursePaymentByExternalIds,
  getFrontendUrl,
  getPaymentCurrency,
  getPurchaseContext,
  getStudentCourseRedirect,
  getStripeClient,
  getStripeWebhookSecret,
  markCoursePaymentStatus,
  normalizeAmount,
  toStripeUnitAmount,
};
