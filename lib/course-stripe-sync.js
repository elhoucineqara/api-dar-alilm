const Stripe = require('stripe');
const User = require('../models/User');
const { isStripeConnectReady } = require('./user-payment-settings');

function getStripeClient() {
  const secretKey = process.env.STRIPE_SECRET_KEY;

  if (!secretKey) {
    const error = new Error('STRIPE_SECRET_KEY is required to sync paid courses with Stripe.');
    error.statusCode = 500;
    throw error;
  }

  return new Stripe(secretKey);
}

function getPaymentCurrency() {
  return (process.env.PAYMENT_CURRENCY || 'USD').toUpperCase();
}

function getInstructorId(course) {
  return String(course?.instructorId?._id || course?.instructorId || '').trim();
}

function normalizeCoursePrice(price) {
  const parsedPrice = Number(price || 0);

  if (!Number.isFinite(parsedPrice) || parsedPrice <= 0) {
    return 0;
  }

  return Number(parsedPrice.toFixed(2));
}

function toStripeUnitAmount(amount) {
  return Math.round(normalizeCoursePrice(amount) * 100);
}

function isStripeMissingResource(error) {
  return error?.code === 'resource_missing' || error?.statusCode === 404;
}

function buildStripeMetadata(course) {
  return {
    courseId: String(course._id),
    instructorId: getInstructorId(course),
    source: 'daralilm-course',
  };
}

function buildProductPayload(course) {
  return {
    name: course.title,
    description: course.description ? course.description.slice(0, 5000) : undefined,
    active: true,
    metadata: buildStripeMetadata(course),
  };
}

function getStripeRequestOptions(stripeAccountId) {
  return stripeAccountId ? { stripeAccount: stripeAccountId } : undefined;
}

async function getInstructorStripeAccountId(course) {
  const instructorId = getInstructorId(course);
  if (!instructorId) {
    return null;
  }

  const instructor = await User.findById(instructorId).select('paymentSettings.stripeConnect').lean();
  if (!instructor || !isStripeConnectReady(instructor)) {
    return null;
  }

  return instructor.paymentSettings?.stripeConnect?.accountId || null;
}

async function createOrUpdateStripeProduct(stripe, course, stripeAccountId) {
  if (course.stripeProductId) {
    try {
      return await stripe.products.update(
        course.stripeProductId,
        buildProductPayload(course),
        getStripeRequestOptions(stripeAccountId)
      );
    } catch (error) {
      if (!isStripeMissingResource(error)) {
        throw error;
      }

      course.stripeProductId = undefined;
    }
  }

  const product = await stripe.products.create(
    buildProductPayload(course),
    getStripeRequestOptions(stripeAccountId)
  );
  course.stripeProductId = product.id;
  return product;
}

async function createOrUpdateStripePrice(stripe, course, product, stripeAccountId) {
  const currency = getPaymentCurrency().toLowerCase();
  const unitAmount = toStripeUnitAmount(course.price);
  const currentPriceId = course.stripePriceId || null;

  if (currentPriceId) {
    try {
      const currentPrice = await stripe.prices.retrieve(
        currentPriceId,
        getStripeRequestOptions(stripeAccountId)
      );
      const isMatchingPrice =
        currentPrice.active &&
        currentPrice.product === product.id &&
        currentPrice.currency === currency &&
        currentPrice.unit_amount === unitAmount;

      if (isMatchingPrice) {
        course.paymentCurrency = currency.toUpperCase();
        return currentPrice;
      }
    } catch (error) {
      if (!isStripeMissingResource(error)) {
        throw error;
      }
    }
  }

  const nextPrice = await stripe.prices.create({
    product: product.id,
    currency,
    unit_amount: unitAmount,
    metadata: buildStripeMetadata(course),
    nickname: `${course.title} price`,
  }, getStripeRequestOptions(stripeAccountId));

  if (currentPriceId && currentPriceId !== nextPrice.id) {
    try {
      await stripe.prices.update(
        currentPriceId,
        { active: false },
        getStripeRequestOptions(stripeAccountId)
      );
    } catch (error) {
      if (!isStripeMissingResource(error)) {
        throw error;
      }
    }
  }

  course.stripePriceId = nextPrice.id;
  course.paymentCurrency = currency.toUpperCase();
  return nextPrice;
}

async function archiveCourseStripeCatalog(course, options = {}) {
  if (!course?.stripeProductId && !course?.stripePriceId) {
    return;
  }

  const stripe = getStripeClient();
  const stripeAccountId = options.stripeAccountId || course.stripeAccountId || null;

  if (course.stripePriceId) {
    try {
      await stripe.prices.update(
        course.stripePriceId,
        { active: false },
        getStripeRequestOptions(stripeAccountId)
      );
    } catch (error) {
      if (!isStripeMissingResource(error)) {
        throw error;
      }
    }
  }

  if (course.stripeProductId) {
    try {
      await stripe.products.update(
        course.stripeProductId,
        { active: false },
        getStripeRequestOptions(stripeAccountId)
      );
    } catch (error) {
      if (!isStripeMissingResource(error)) {
        throw error;
      }
    }
  }
}

async function syncCourseStripeData(course) {
  if (!course) {
    return course;
  }

  course.price = normalizeCoursePrice(course.price);

  if (course.price <= 0) {
    if (course.stripeProductId || course.stripePriceId) {
      await archiveCourseStripeCatalog(course);
    }

    course.stripeProductId = undefined;
    course.stripePriceId = undefined;
    course.stripeAccountId = undefined;
    course.paymentCurrency = undefined;
    return course;
  }

  if (course.status !== 'published' || course.enrollmentOpen === false) {
    if (course.stripeProductId || course.stripePriceId) {
      await archiveCourseStripeCatalog(course);
    }

    return course;
  }

  const stripeAccountId = await getInstructorStripeAccountId(course);

  if (!stripeAccountId) {
    if (course.stripeProductId || course.stripePriceId) {
      await archiveCourseStripeCatalog(course);
    }

    course.stripeProductId = undefined;
    course.stripePriceId = undefined;
    course.stripeAccountId = undefined;
    course.paymentCurrency = undefined;
    return course;
  }

  if (
    course.stripeAccountId &&
    course.stripeAccountId !== stripeAccountId &&
    (course.stripeProductId || course.stripePriceId)
  ) {
    await archiveCourseStripeCatalog(course, {
      stripeAccountId: course.stripeAccountId,
    });
    course.stripeProductId = undefined;
    course.stripePriceId = undefined;
  }

  const stripe = getStripeClient();
  const product = await createOrUpdateStripeProduct(stripe, course, stripeAccountId);
  await createOrUpdateStripePrice(stripe, course, product, stripeAccountId);
  course.stripeAccountId = stripeAccountId;
  return course;
}

module.exports = {
  archiveCourseStripeCatalog,
  getPaymentCurrency,
  getStripeClient,
  syncCourseStripeData,
  toStripeUnitAmount,
};
