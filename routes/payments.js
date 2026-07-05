const express = require('express');

const CoursePayment = require('../models/CoursePayment');
const User = require('../models/User');
const {
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
} = require('../lib/course-payments');
const {
  calculateMarketplaceBreakdown,
  getPlatformFeePercent,
} = require('../lib/platform-settings');
const {
  getCompletedCapture,
  getOrderIdFromWebhookResource,
  getApprovalUrl,
  paypalApiFetch,
  verifyPayPalWebhook,
} = require('../lib/paypal');
const { getPayPalPartnerHeaders } = require('../lib/paypal-marketplace');
const { syncCourseStripeData } = require('../lib/course-stripe-sync');
const { requireAuthUser } = require('../lib/request-auth');

const router = express.Router();

function respondWithError(res, error, fallbackMessage) {
  const statusCode = error?.statusCode || 400;
  return res.status(statusCode).json({
    error: error?.message || fallbackMessage,
  });
}

function getInstructorPlatformFeePercent(instructor, defaultPercent) {
  if (instructor?.role === 'admin') {
    return 0;
  }

  if (instructor?.customPlatformFeePercent !== undefined && instructor?.customPlatformFeePercent !== null) {
    return Number(instructor.customPlatformFeePercent);
  }

  return defaultPercent;
}

function getPayPalRequestHeaders(options = {}) {
  const headers = {};

  if (options.preferRepresentation) {
    headers.Prefer = 'return=representation';
  }

  if (options.requestId) {
    headers['PayPal-Request-Id'] = options.requestId;
  }

  if (options.sellerMerchantId) {
    Object.assign(
      headers,
      getPayPalPartnerHeaders({
        sellerMerchantId: options.sellerMerchantId,
      })
    );
  }

  return headers;
}

async function syncUserStripeCustomer(userId, stripeCustomerId) {
  if (!userId || !stripeCustomerId) {
    return null;
  }

  const user = await User.findById(userId);
  if (!user) {
    return null;
  }

  user.paymentSettings = user.paymentSettings || {};
  if (user.paymentSettings.stripeCustomerId === stripeCustomerId) {
    return user;
  }

  user.paymentSettings.stripeCustomerId = stripeCustomerId;
  await user.save();
  return user;
}

async function finalizeStripeSession(session) {
  if (!session?.metadata?.userId || !session?.metadata?.courseId) {
    return null;
  }

  if (session.payment_status !== 'paid') {
    return null;
  }

  const amountTotal =
    typeof session.amount_total === 'number'
      ? Number((session.amount_total / 100).toFixed(2))
      : null;

  if (typeof session.customer === 'string' && session.customer) {
    await syncUserStripeCustomer(session.metadata.userId, session.customer);
  }

  return finalizeCoursePayment({
    provider: 'stripe',
    internalPaymentId: session.metadata.paymentId || null,
    userId: session.metadata.userId,
    courseId: session.metadata.courseId,
    instructorId: session.metadata.instructorId || null,
    externalCheckoutId: session.id,
    externalPaymentId:
      typeof session.payment_intent === 'string'
        ? session.payment_intent
        : session.payment_intent?.id || null,
    amount: amountTotal,
    currency: session.currency?.toUpperCase() || getPaymentCurrency(),
    platformFeePercent:
      session.metadata.platformFeePercent !== undefined
        ? Number(session.metadata.platformFeePercent)
        : undefined,
    platformFeeAmount:
      session.metadata.platformFeeAmount !== undefined
        ? Number(session.metadata.platformFeeAmount)
        : undefined,
    instructorAmount:
      session.metadata.instructorAmount !== undefined
        ? Number(session.metadata.instructorAmount)
        : undefined,
    paidAt: new Date(),
    metadata: {
      stripeSessionId: session.id,
    },
  });
}

async function getPayPalOrderSummary(orderId, options = {}) {
  const order = await paypalApiFetch(`/v2/checkout/orders/${orderId}`, {
    headers: getPayPalRequestHeaders({
      sellerMerchantId: options.sellerMerchantId,
    }),
  });
  const purchaseUnit = Array.isArray(order.purchase_units) ? order.purchase_units[0] : null;
  const capture = getCompletedCapture(order);

  return {
    order,
    orderId: order.id,
    courseId: purchaseUnit?.reference_id || null,
    userId: purchaseUnit?.custom_id || null,
    internalPaymentId: purchaseUnit?.invoice_id || null,
    amount: normalizeAmount(purchaseUnit?.amount?.value || capture?.amount?.value || 0),
    currency:
      purchaseUnit?.amount?.currency_code?.toUpperCase() ||
      capture?.amount?.currency_code?.toUpperCase() ||
      getPaymentCurrency(),
    captureId: capture?.id || null,
    status: order.status,
    payerId: order.payer?.payer_id || null,
    paidAt: capture?.create_time ? new Date(capture.create_time) : new Date(),
  };
}

router.post('/stripe/checkout', async (req, res) => {
  try {
    const authUser = await requireAuthUser(req);
    const { courseId } = req.body || {};

    if (!courseId) {
      return res.status(400).json({ error: 'Course ID is required.' });
    }

    const context = await getPurchaseContext({
      courseId,
      userId: authUser.userId,
    });

    if (context.alreadyPurchased) {
      return res.status(409).json({
        error: 'You already own this course.',
        redirectTo: getStudentCourseRedirect(courseId),
      });
    }

    if (!context.instructorPaymentProviders?.stripe) {
      return res.status(400).json({
        error: 'This instructor has not finished connecting Stripe for card payments yet.',
      });
    }

    await syncCourseStripeData(context.course);
    if (context.course.isModified()) {
      await context.course.save();
    }

    const stripeConnectedAccountId =
      context.instructor?.paymentSettings?.stripeConnect?.accountId || null;
    if (!stripeConnectedAccountId) {
      return res.status(400).json({
        error: 'This instructor has not finished connecting Stripe for card payments yet.',
      });
    }

    const platformFeePercent = getInstructorPlatformFeePercent(
      context.instructor,
      await getPlatformFeePercent()
    );
    const breakdown = calculateMarketplaceBreakdown(context.course.price, platformFeePercent);

    const payment = await createPendingCoursePayment({
      userId: authUser.userId,
      courseId,
      instructorId: context.course.instructorId,
      provider: 'stripe',
      amount: context.course.price,
      currency: getPaymentCurrency(),
      platformFeePercent: breakdown.platformFeePercent,
      platformFeeAmount: breakdown.platformFeeAmount,
      instructorAmount: breakdown.instructorAmount,
      metadata: {
        stripeConnectedAccountId,
      },
    });

    const stripe = getStripeClient();
    const sessionPayload = {
      mode: 'payment',
      payment_method_types: ['card'],
      billing_address_collection: 'auto',
      line_items: [
        {
          price_data: {
            currency: getPaymentCurrency().toLowerCase(),
            unit_amount: toStripeUnitAmount(context.course.price),
            product_data: {
              name: context.course.title,
              description: context.course.description
                ? context.course.description.slice(0, 500)
                : undefined,
              metadata: {
                courseId: context.course._id.toString(),
                instructorId: String(context.course.instructorId),
              },
            },
          },
          quantity: 1,
        },
      ],
      metadata: {
        paymentId: payment._id.toString(),
        userId: authUser.userId,
        courseId: context.course._id.toString(),
        instructorId: String(context.course.instructorId),
        platformFeePercent: breakdown.platformFeePercent.toString(),
        platformFeeAmount: breakdown.platformFeeAmount.toString(),
        instructorAmount: breakdown.instructorAmount.toString(),
      },
      payment_intent_data: {
        transfer_data: {
          destination: stripeConnectedAccountId,
        },
        setup_future_usage: 'off_session',
        metadata: {
          paymentId: payment._id.toString(),
          userId: authUser.userId,
          courseId: context.course._id.toString(),
        },
      },
      success_url: `${getFrontendUrl()}/checkout/result?provider=stripe&courseId=${context.course._id}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${getFrontendUrl()}/checkout/result?provider=stripe&courseId=${context.course._id}&status=cancelled`,
    };

    if (breakdown.platformFeeAmount > 0) {
      sessionPayload.payment_intent_data.application_fee_amount = toStripeUnitAmount(
        breakdown.platformFeeAmount
      );
    }

    if (context.user.paymentSettings?.stripeCustomerId) {
      sessionPayload.customer = context.user.paymentSettings.stripeCustomerId;
    } else {
      sessionPayload.customer_email = context.user.email;
      sessionPayload.customer_creation = 'always';
    }

    const session = await stripe.checkout.sessions.create(sessionPayload);

    payment.externalCheckoutId = session.id;
    payment.metadata = {
      ...(payment.metadata || {}),
      stripeSessionId: session.id,
      stripeConnectedAccountId,
    };
    await payment.save();

    if (!session.url) {
      throw new Error('Stripe did not return a checkout URL.');
    }

    return res.json({
      checkoutUrl: session.url,
      paymentId: payment._id,
    });
  } catch (error) {
    return respondWithError(res, error, 'Unable to start Stripe checkout.');
  }
});

router.get('/stripe/session/:sessionId', async (req, res) => {
  try {
    const authUser = await requireAuthUser(req);
    const stripe = getStripeClient();
    const session = await stripe.checkout.sessions.retrieve(req.params.sessionId, {
      expand: ['payment_intent'],
    });

    if (session.metadata?.userId !== authUser.userId) {
      return res.status(403).json({ error: 'This Stripe session does not belong to you.' });
    }

    if (session.payment_status === 'paid') {
      await finalizeStripeSession(session);
      return res.json({
        status: 'completed',
        redirectTo: getStudentCourseRedirect(session.metadata.courseId),
      });
    }

    return res.json({
      status: session.status === 'expired' ? 'cancelled' : 'pending',
      redirectTo: `/courses/${session.metadata.courseId}`,
    });
  } catch (error) {
    return respondWithError(res, error, 'Unable to confirm the Stripe payment.');
  }
});

router.post(
  '/stripe/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    try {
      const stripe = getStripeClient();
      const signature = req.headers['stripe-signature'];

      if (!signature) {
        return res.status(400).json({ error: 'Missing Stripe signature.' });
      }

      const event = stripe.webhooks.constructEvent(
        req.body,
        signature,
        getStripeWebhookSecret()
      );

      switch (event.type) {
        case 'checkout.session.completed':
        case 'checkout.session.async_payment_succeeded': {
          const session = event.data.object;
          await finalizeStripeSession(session);
          break;
        }
        case 'checkout.session.async_payment_failed': {
          const session = event.data.object;
          await markCoursePaymentStatus({
            provider: 'stripe',
            externalCheckoutId: session.id,
            status: 'failed',
            metadata: {
              stripeEventType: event.type,
            },
          });
          break;
        }
        case 'checkout.session.expired': {
          const session = event.data.object;
          await markCoursePaymentStatus({
            provider: 'stripe',
            externalCheckoutId: session.id,
            status: 'cancelled',
            metadata: {
              stripeEventType: event.type,
            },
          });
          break;
        }
        default:
          break;
      }

      return res.json({ received: true });
    } catch (error) {
      return respondWithError(res, error, 'Stripe webhook error.');
    }
  }
);

router.post('/paypal/order', async (req, res) => {
  try {
    const authUser = await requireAuthUser(req);
    const { courseId } = req.body || {};

    if (!courseId) {
      return res.status(400).json({ error: 'Course ID is required.' });
    }

    const context = await getPurchaseContext({
      courseId,
      userId: authUser.userId,
    });

    if (context.alreadyPurchased) {
      return res.status(409).json({
        error: 'You already own this course.',
        redirectTo: getStudentCourseRedirect(courseId),
      });
    }

    if (context.instructor?.role !== 'admin') {
      return res.status(400).json({
        error:
          'PayPal is reserved for admin-owned course revenue. Instructor course sales use Stripe only.',
      });
    }

    const platformFeePercent = getInstructorPlatformFeePercent(
      context.instructor,
      await getPlatformFeePercent()
    );
    const breakdown = calculateMarketplaceBreakdown(context.course.price, platformFeePercent);

    const payment = await createPendingCoursePayment({
      userId: authUser.userId,
      courseId,
      instructorId: context.course.instructorId,
      provider: 'paypal',
      amount: context.course.price,
      currency: getPaymentCurrency(),
      platformFeePercent: breakdown.platformFeePercent,
      platformFeeAmount: breakdown.platformFeeAmount,
      instructorAmount: breakdown.instructorAmount,
      metadata: {
        revenueOwner: 'admin',
      },
    });

    const order = await paypalApiFetch('/v2/checkout/orders', {
      method: 'POST',
      headers: getPayPalRequestHeaders({
        preferRepresentation: true,
        requestId: payment._id.toString(),
      }),
      json: {
        intent: 'CAPTURE',
        purchase_units: [
          {
            reference_id: context.course._id.toString(),
            custom_id: authUser.userId,
            invoice_id: payment._id.toString(),
            description: `Lifetime access to ${context.course.title} on Dar Al-Ilm`,
            amount: {
              currency_code: getPaymentCurrency(),
              value: normalizeAmount(context.course.price).toFixed(2),
            },
          },
        ],
        payment_source: {
          paypal: {
            experience_context: {
              brand_name: 'Dar Al-Ilm',
              locale: 'en-US',
              landing_page: 'LOGIN',
              user_action: 'PAY_NOW',
              shipping_preference: 'NO_SHIPPING',
              return_url: `${getFrontendUrl()}/checkout/result?provider=paypal&courseId=${context.course._id}`,
              cancel_url: `${getFrontendUrl()}/checkout/result?provider=paypal&courseId=${context.course._id}&status=cancelled`,
            },
          },
        },
      },
    });

    const approvalUrl = getApprovalUrl(order);
    if (!approvalUrl) {
      throw new Error('PayPal did not return an approval URL.');
    }

    payment.externalCheckoutId = order.id;
    payment.metadata = {
      ...(payment.metadata || {}),
      paypalOrderId: order.id,
      revenueOwner: 'admin',
    };
    await payment.save();

    return res.json({
      approvalUrl,
      orderId: order.id,
      paymentId: payment._id,
    });
  } catch (error) {
    return respondWithError(res, error, 'Unable to start PayPal checkout.');
  }
});

router.post('/paypal/capture', async (req, res) => {
  try {
    const authUser = await requireAuthUser(req);
    const { orderId } = req.body || {};

    if (!orderId) {
      return res.status(400).json({ error: 'Order ID is required.' });
    }

    const existingPayment = await findCoursePaymentByExternalIds({
      provider: 'paypal',
      externalCheckoutId: orderId,
    });

    if (existingPayment && String(existingPayment.userId) !== authUser.userId) {
      return res.status(403).json({ error: 'This PayPal order does not belong to you.' });
    }

    const sellerMerchantId = existingPayment?.metadata?.sellerMerchantId || null;

    let order;
    try {
      order = await paypalApiFetch(`/v2/checkout/orders/${orderId}/capture`, {
        method: 'POST',
        headers: getPayPalRequestHeaders({
          preferRepresentation: true,
          sellerMerchantId,
        }),
      });
    } catch (error) {
      if (String(error.message || '').includes('ORDER_ALREADY_CAPTURED')) {
        order = await paypalApiFetch(`/v2/checkout/orders/${orderId}`, {
          headers: getPayPalRequestHeaders({
            sellerMerchantId,
          }),
        });
      } else {
        throw error;
      }
    }

    const summary = await getPayPalOrderSummary(order.id, {
      sellerMerchantId,
    });
    if (summary.userId !== authUser.userId) {
      return res.status(403).json({ error: 'This PayPal order does not belong to you.' });
    }

    if (summary.status !== 'COMPLETED') {
      return res.json({
        status: 'pending',
        redirectTo: `/courses/${summary.courseId}`,
      });
    }

    await finalizeCoursePayment({
      provider: 'paypal',
      internalPaymentId: summary.internalPaymentId,
      userId: summary.userId,
      courseId: summary.courseId,
      instructorId: existingPayment?.instructorId || null,
      externalCheckoutId: summary.orderId,
      externalPaymentId: summary.captureId,
      amount: summary.amount,
      currency: summary.currency,
      platformFeePercent: existingPayment?.platformFeePercent,
      platformFeeAmount: existingPayment?.platformFeeAmount,
      instructorAmount: existingPayment?.instructorAmount,
      paidAt: summary.paidAt,
      metadata: {
        paypalOrderId: summary.orderId,
        paypalPayerId: summary.payerId,
        ...(sellerMerchantId ? { sellerMerchantId } : {}),
        revenueOwner: existingPayment?.metadata?.revenueOwner || 'admin',
      },
    });

    return res.json({
      status: 'completed',
      redirectTo: getStudentCourseRedirect(summary.courseId),
    });
  } catch (error) {
    return respondWithError(res, error, 'Unable to confirm the PayPal payment.');
  }
});

router.post(
  '/paypal/webhook',
  express.text({ type: 'application/json' }),
  async (req, res) => {
    try {
      const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
      const isValid = await verifyPayPalWebhook(req.headers, rawBody);

      if (!isValid) {
        return res.status(400).json({ error: 'Invalid PayPal signature.' });
      }

      const event = JSON.parse(rawBody);
      const { event_type: eventType, resource = {} } = event;

      switch (eventType) {
        case 'PAYMENT.CAPTURE.COMPLETED': {
          const orderId = getOrderIdFromWebhookResource(resource);
          if (!orderId) {
            break;
          }

          const payment = await findCoursePaymentByExternalIds({
            provider: 'paypal',
            externalCheckoutId: orderId,
            externalPaymentId: resource.id || null,
          });
          const sellerMerchantId = payment?.metadata?.sellerMerchantId || null;
          const summary = await getPayPalOrderSummary(orderId, {
            sellerMerchantId,
          });
          if (!summary.userId || !summary.courseId) {
            break;
          }

          await finalizeCoursePayment({
            provider: 'paypal',
            internalPaymentId: summary.internalPaymentId,
            userId: summary.userId,
            courseId: summary.courseId,
            instructorId: payment?.instructorId || null,
            externalCheckoutId: summary.orderId,
            externalPaymentId: summary.captureId,
            amount: summary.amount,
            currency: summary.currency,
            platformFeePercent: payment?.platformFeePercent,
            platformFeeAmount: payment?.platformFeeAmount,
            instructorAmount: payment?.instructorAmount,
            paidAt: summary.paidAt,
            metadata: {
              paypalOrderId: summary.orderId,
              paypalWebhookEvent: eventType,
              ...(sellerMerchantId ? { sellerMerchantId } : {}),
              revenueOwner: payment?.metadata?.revenueOwner || 'admin',
            },
          });
          break;
        }
        case 'PAYMENT.CAPTURE.DENIED':
        case 'PAYMENT.CAPTURE.DECLINED': {
          const orderId = getOrderIdFromWebhookResource(resource);
          if (!orderId) {
            break;
          }

          await markCoursePaymentStatus({
            provider: 'paypal',
            externalCheckoutId: orderId,
            externalPaymentId: resource.id || null,
            status: 'failed',
            metadata: {
              paypalWebhookEvent: eventType,
            },
          });
          break;
        }
        default:
          break;
      }

      return res.json({ received: true });
    } catch (error) {
      return respondWithError(res, error, 'PayPal webhook error.');
    }
  }
);

router.get('/course/:courseId/status', async (req, res) => {
  try {
    const authUser = await requireAuthUser(req);
    const payment = await CoursePayment.findOne({
      userId: authUser.userId,
      courseId: req.params.courseId,
      status: 'completed',
    })
      .sort({ paidAt: -1, createdAt: -1 })
      .lean();

    return res.json({
      hasPurchased: Boolean(payment),
      payment,
      redirectTo: payment
        ? getStudentCourseRedirect(req.params.courseId)
        : `/courses/${req.params.courseId}`,
    });
  } catch (error) {
    return respondWithError(res, error, 'Unable to read course payment status.');
  }
});

module.exports = router;
