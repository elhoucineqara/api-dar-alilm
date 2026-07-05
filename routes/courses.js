const express = require('express');
const router = express.Router();
const Course = require('../models/Course');
const Category = require('../models/Category');
const Enrollment = require('../models/Enrollment');
const CoursePayment = require('../models/CoursePayment');
const UserInteraction = require('../models/UserInteraction');
const User = require('../models/User');
const { archiveCourseStripeCatalog, syncCourseStripeData } = require('../lib/course-stripe-sync');
const {
  assertUserCanPublishCoursePublicly,
  requireCreatorUser,
} = require('../lib/creator-access');
const { hasInstructorPaymentProvider } = require('../lib/user-payment-settings');

function isApprovedCategory(category) {
  return Boolean(category) && (!category.approvalStatus || category.approvalStatus === 'approved');
}

function isPendingCategory(category) {
  return category?.approvalStatus === 'pending';
}

function createCategorySelectionError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

async function resolveCourseCategorySelection({ categoryId, requestedCategoryId }) {
  const activeCategory = categoryId ? await Category.findById(categoryId) : null;
  if (!activeCategory) {
    throw createCategorySelectionError('Category not found.', 404);
  }

  if (!isApprovedCategory(activeCategory)) {
    throw createCategorySelectionError(
      'Courses can only use approved categories as their active category.'
    );
  }

  if (!requestedCategoryId) {
    return {
      categoryId: activeCategory._id,
      requestedCategoryId: undefined,
    };
  }

  const requestedCategory = await Category.findById(requestedCategoryId);
  if (!requestedCategory) {
    throw createCategorySelectionError('Requested category not found.', 404);
  }

  if (isApprovedCategory(requestedCategory)) {
    return {
      categoryId: requestedCategory._id,
      requestedCategoryId: undefined,
    };
  }

  if (!isPendingCategory(requestedCategory)) {
    throw createCategorySelectionError('Requested category is not available yet.');
  }

  if (!activeCategory.isDefault) {
    throw createCategorySelectionError(
      'Pending category requests must use a default category as a temporary fallback.'
    );
  }

  return {
    categoryId: activeCategory._id,
    requestedCategoryId: requestedCategory._id,
  };
}

// GET all courses for the instructor
router.get('/', requireCreatorUser, async (req, res) => {
  try {
    const courses = await Course.find({ instructorId: req.user.userId })
      .populate('categoryId', 'name')
      .sort({ createdAt: -1 })
      .lean();

    if (courses.length === 0) {
      return res.json({ courses: [] });
    }

    const courseIds = courses.map((course) => course._id);
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    const revenueExpression = {
      $ifNull: [
        '$instructorAmount',
        {
          $subtract: [
            { $ifNull: ['$amount', 0] },
            { $ifNull: ['$platformFeeAmount', 0] },
          ],
        },
      ],
    };

    const [enrollmentStats, paymentStats, ratingStats] = await Promise.all([
      Enrollment.aggregate([
        {
          $match: {
            courseId: { $in: courseIds },
          },
        },
        {
          $group: {
            _id: '$courseId',
            studentsCount: { $sum: 1 },
            monthlyEnrollments: {
              $sum: {
                $cond: [{ $gte: ['$enrolledAt', monthStart] }, 1, 0],
              },
            },
          },
        },
      ]),
      CoursePayment.aggregate([
        {
          $match: {
            courseId: { $in: courseIds },
            status: 'completed',
          },
        },
        {
          $group: {
            _id: '$courseId',
            totalRevenue: { $sum: revenueExpression },
            monthlyRevenue: {
              $sum: {
                $cond: [
                  { $gte: [{ $ifNull: ['$paidAt', '$createdAt'] }, monthStart] },
                  revenueExpression,
                  0,
                ],
              },
            },
            salesCount: { $sum: 1 },
            currency: { $first: '$currency' },
          },
        },
      ]),
      UserInteraction.aggregate([
        {
          $match: {
            courseId: { $in: courseIds },
            interactionType: 'rating',
            rating: { $type: 'number' },
          },
        },
        {
          $group: {
            _id: '$courseId',
            averageRating: { $avg: '$rating' },
            ratingsCount: { $sum: 1 },
          },
        },
      ]),
    ]);

    const enrollmentStatsByCourseId = new Map(
      enrollmentStats.map((stat) => [String(stat._id), stat])
    );
    const paymentStatsByCourseId = new Map(
      paymentStats.map((stat) => [String(stat._id), stat])
    );
    const ratingStatsByCourseId = new Map(
      ratingStats.map((stat) => [String(stat._id), stat])
    );

    const coursesWithStats = courses.map((course) => {
      const courseId = String(course._id);
      const enrollmentStat = enrollmentStatsByCourseId.get(courseId);
      const paymentStat = paymentStatsByCourseId.get(courseId);
      const ratingStat = ratingStatsByCourseId.get(courseId);

      return {
        ...course,
        studentsCount: enrollmentStat?.studentsCount || 0,
        monthlyEnrollments: enrollmentStat?.monthlyEnrollments || 0,
        totalRevenue: Number(Number(paymentStat?.totalRevenue || 0).toFixed(2)),
        monthlyRevenue: Number(Number(paymentStat?.monthlyRevenue || 0).toFixed(2)),
        salesCount: paymentStat?.salesCount || 0,
        currency: paymentStat?.currency || course.paymentCurrency || 'USD',
        averageRating:
          ratingStat?.ratingsCount > 0
            ? Number(Number(ratingStat.averageRating || 0).toFixed(1))
            : null,
        ratingsCount: ratingStat?.ratingsCount || 0,
      };
    });

    res.json({ courses: coursesWithStats });
  } catch (error) {
    console.error('Error fetching courses:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST create a new course
router.post('/', requireCreatorUser, async (req, res) => {
  try {
    const {
      title,
      description,
      categoryId,
      requestedCategoryId,
      price,
      thumbnail,
      status,
    } = req.body;

    if (!title || !description || !categoryId) {
      return res.status(400).json({ error: 'Title, description, and category are required' });
    }

    const categorySelection = await resolveCourseCategorySelection({
      categoryId,
      requestedCategoryId: requestedCategoryId || undefined,
    });

    const nextStatus = status || 'draft';
    if (nextStatus === 'published') {
      assertUserCanPublishCoursePublicly(req.user, req.platformAccess);
    }

    const course = new Course({
      title,
      description,
      categoryId: categorySelection.categoryId,
      requestedCategoryId: categorySelection.requestedCategoryId,
      instructorId: req.user.userId,
      price: price || 0,
      thumbnail,
      status: nextStatus,
      modules: [],
    });

    await ensurePublishedPaidCourseHasProvider(course);
    await syncCourseStripeData(course);
    await course.save();
    res.status(201).json({ course });
  } catch (error) {
    console.error('Error creating course:', error);
    return respondWithError(res, error);
  }
});

const Module = require('../models/Module');
const Section = require('../models/Section');
const Quiz = require('../models/Quiz');
const Question = require('../models/Question');
const Answer = require('../models/Answer');

function respondWithError(res, error, fallbackMessage = 'Internal server error') {
  const statusCode = error?.statusCode || 500;

  return res.status(statusCode).json({
    error: error?.message || fallbackMessage,
  });
}

async function ensurePublishedPaidCourseHasProvider(course) {
  if (
    !course ||
    course.status !== 'published' ||
    course.enrollmentOpen === false ||
    Number(course.price || 0) <= 0
  ) {
    return;
  }

  const instructor = await User.findById(course.instructorId).select('paymentSettings').lean();
  if (!instructor || !hasInstructorPaymentProvider(instructor)) {
    const error = new Error(
      'Connect Stripe or PayPal in Instructor Payments before publishing a paid course.'
    );
    error.statusCode = 400;
    throw error;
  }
}

async function loadQuizWithQuestions(quizId) {
  if (!quizId) return null;

  const quiz = await Quiz.findById(quizId).lean();
  if (!quiz) return null;

  if (quiz.questions && quiz.questions.length > 0) {
    const questionsData = await Question.find({ _id: { $in: quiz.questions } })
      .sort({ order: 1 })
      .lean();

    quiz.questions = await Promise.all(
      questionsData.map(async (question) => {
        if (question.answers && question.answers.length > 0) {
          const answers = await Answer.find({ _id: { $in: question.answers } })
            .sort({ order: 1 })
            .lean();
          return { ...question, answers };
        }

        return { ...question, answers: [] };
      })
    );
  }

  return quiz;
}

// GET a single course with modules
router.get('/:id', requireCreatorUser, async (req, res) => {
  try {
    const courseId = req.params.id;

    const course = await Course.findOne({ _id: courseId, instructorId: req.user.userId })
      .populate('categoryId', 'name')
      .lean();
    
    if (!course) {
      return res.status(404).json({ error: 'Course not found' });
    }

    // Load modules separately
    const modulesData = await Module.find({ courseId: courseId })
      .sort({ order: 1 })
      .lean();
    
    // Load sections and quizzes for each module manually
    const modules = await Promise.all(
      modulesData.map(async (module) => {
        let sections = [];
        let quiz = null;
        
        if (module.sections && module.sections.length > 0) {
          try {
            sections = await Section.find({ _id: { $in: module.sections } })
              .sort({ order: 1 })
              .lean();
            sections = await Promise.all(
              sections.map(async (section) => {
                if (section.type === 'quiz' && section.quizId) {
                  return { ...section, quiz: await loadQuizWithQuestions(section.quizId) };
                }
                return section;
              })
            );
          } catch (error) {
            console.error('Error loading sections:', error);
          }
        }
        
        if (module.quiz) {
          try {
            quiz = await Quiz.findById(module.quiz).lean();
            if (quiz && quiz.questions && quiz.questions.length > 0) {
              const questionsData = await Question.find({ _id: { $in: quiz.questions } })
                .sort({ order: 1 })
                .lean();
              
              const questions = await Promise.all(
                questionsData.map(async (question) => {
                  if (question.answers && question.answers.length > 0) {
                    const answers = await Answer.find({ _id: { $in: question.answers } })
                      .sort({ order: 1 })
                      .lean();
                    return { ...question, answers };
                  }
                  return { ...question, answers: [] };
                })
              );
              quiz.questions = questions;
            }
          } catch (error) {
            console.error('Error loading quiz:', error);
          }
        }
        
        return { ...module, sections, quiz };
      })
    );

    // Load final exam
    let finalExam = null;
    if (course.finalExam) {
      finalExam = await Quiz.findById(course.finalExam).lean();
      if (finalExam && finalExam.questions && finalExam.questions.length > 0) {
        const questionsData = await Question.find({ _id: { $in: finalExam.questions } })
          .sort({ order: 1 })
          .lean();
        
        const questions = await Promise.all(
          questionsData.map(async (question) => {
            if (question.answers && question.answers.length > 0) {
              const answers = await Answer.find({ _id: { $in: question.answers } })
                .sort({ order: 1 })
                .lean();
              return { ...question, answers };
            }
            return { ...question, answers: [] };
          })
        );
        finalExam.questions = questions;
      }
    }

    res.json({
      course: {
        ...course,
        modules,
        finalExam,
      },
    });
  } catch (error) {
    console.error('Error fetching course:', error);
    if (error.name === 'CastError') {
      return res.status(400).json({ error: 'Invalid course ID' });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET course training content (sections, quizzes, final exam in order) for instructors
router.get('/:id/training', requireCreatorUser, async (req, res) => {
  try {
    const courseId = req.params.id;

    // Get course and verify ownership
    const course = await Course.findOne({ 
      _id: courseId, 
      instructorId: req.user.userId 
    })
      .populate('categoryId', 'name')
      .populate('instructorId', 'firstName lastName')
      .populate({
        path: 'finalExam',
        populate: {
          path: 'questions',
          populate: {
            path: 'answers'
          },
          options: { sort: { order: 1 } }
        }
      })
      .lean();

    if (!course) {
      return res.status(404).json({ error: 'Course not found' });
    }

    // Get modules with populate
    const modulesData = await Module.find({ courseId })
      .sort({ order: 1 })
      .populate({
        path: 'quiz',
        populate: {
          path: 'questions',
          populate: {
            path: 'answers'
          },
          options: { sort: { order: 1 } }
        }
      })
      .lean();

    // Build training content in order
    const trainingContent = [];

    // Process each module
    for (const module of modulesData) {
      // Add sections
      const sections = await Section.find({ moduleId: module._id })
        .sort({ order: 1 })
        .lean();

      for (const section of sections) {
        let sectionData = section;
        if (section.type === 'quiz' && section.quizId) {
          sectionData = { ...section, quiz: await loadQuizWithQuestions(section.quizId) };
        }

        trainingContent.push({
          type: section.type === 'quiz' ? 'quiz' : 'section',
          _id: section.type === 'quiz' && section.quizId ? section.quizId : section._id,
          title: section.title,
          moduleId: module._id,
          moduleTitle: module.title,
          order: section.order,
          sectionId: section._id,
          data: section.type === 'quiz' && sectionData.quiz ? sectionData.quiz : sectionData
        });
      }

      // Add module quiz after sections
      if (module.quiz) {
        const quiz = typeof module.quiz === 'object' ? module.quiz : await Quiz.findById(module.quiz)
          .populate({
            path: 'questions',
            populate: {
              path: 'answers'
            },
            options: { sort: { order: 1 } }
          })
          .lean();

        if (quiz) {
          trainingContent.push({
            type: 'quiz',
            _id: quiz._id,
            title: quiz.title || 'Module Quiz',
            moduleId: module._id,
            moduleTitle: module.title,
            order: module.order + 1000, // Place after sections
            isFinalExam: false,
            data: quiz
          });
        }
      }
    }

    // Add final exam at the end
    if (course.finalExam) {
      const finalExam = typeof course.finalExam === 'object' 
        ? course.finalExam 
        : await Quiz.findById(course.finalExam)
            .populate({
              path: 'questions',
              populate: {
                path: 'answers'
              },
              options: { sort: { order: 1 } }
            })
            .lean();

      if (finalExam) {
        trainingContent.push({
          type: 'finalExam',
          _id: finalExam._id,
          title: finalExam.title || 'Final Exam',
          order: 9999, // Always last
          isFinalExam: true,
          data: finalExam
        });
      }
    }

    res.json({
      course: {
        _id: course._id,
        title: course.title,
        description: course.description,
        thumbnail: course.thumbnail,
        instructor: course.instructorId,
        category: course.categoryId
      },
      trainingContent
    });
  } catch (error) {
    console.error('Error fetching training content:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT update a course
router.put('/:id', requireCreatorUser, async (req, res) => {
  try {
    const courseId = req.params.id;
    const {
      title,
      description,
      categoryId,
      requestedCategoryId,
      price,
      thumbnail,
      status,
      enrollmentOpen,
    } = req.body;

    const course = await Course.findOne({
      _id: courseId,
      instructorId: req.user.userId,
    });

    if (!course) {
      return res.status(404).json({ error: 'Course not found' });
    }

    const nextStatus = status !== undefined ? status : course.status;
    const nextEnrollmentOpen =
      enrollmentOpen !== undefined ? Boolean(enrollmentOpen) : course.enrollmentOpen !== false;
    if (nextStatus === 'published' && nextEnrollmentOpen) {
      assertUserCanPublishCoursePublicly(req.user, req.platformAccess);
    }

    if (title !== undefined) course.title = title;
    if (description !== undefined) course.description = description;

    if (categoryId !== undefined || requestedCategoryId !== undefined) {
      const categorySelection = await resolveCourseCategorySelection({
        categoryId: categoryId !== undefined ? categoryId : course.categoryId,
        requestedCategoryId:
          requestedCategoryId !== undefined
            ? requestedCategoryId || undefined
            : course.requestedCategoryId,
      });

      course.categoryId = categorySelection.categoryId;
      course.requestedCategoryId = categorySelection.requestedCategoryId || undefined;
    }

    if (price !== undefined) course.price = price;
    if (thumbnail !== undefined) course.thumbnail = thumbnail;
    if (status !== undefined) course.status = nextStatus;
    if (enrollmentOpen !== undefined) course.enrollmentOpen = nextEnrollmentOpen;

    await ensurePublishedPaidCourseHasProvider(course);
    await syncCourseStripeData(course);
    await course.save();

    res.json({ course });
  } catch (error) {
    console.error('Error updating course:', error);
    return respondWithError(res, error);
  }
});

// DELETE a course
router.delete('/:id', requireCreatorUser, async (req, res) => {
  try {
    const courseId = req.params.id;
    const course = await Course.findOne({ _id: courseId, instructorId: req.user.userId });
    if (!course) {
      return res.status(404).json({ error: 'Course not found' });
    }

    try {
      await archiveCourseStripeCatalog(course);
    } catch (stripeError) {
      console.error('Error archiving Stripe product for deleted course:', stripeError);
    }

    // Delete associated sections and modules
    const modules = await Module.find({ courseId: courseId });
    for (const module of modules) {
      const quizSections = await Section.find({ moduleId: module._id, type: 'quiz', quizId: { $exists: true, $ne: null } });
      for (const section of quizSections) {
        const quiz = await Quiz.findById(section.quizId);
        if (quiz) {
          const questions = await Question.find({ quizId: quiz._id });
          for (const question of questions) {
            await Answer.deleteMany({ questionId: question._id });
          }
          await Question.deleteMany({ quizId: quiz._id });
          await Quiz.findByIdAndDelete(quiz._id);
        }
      }
      await Section.deleteMany({ moduleId: module._id });
      if (module.quiz) {
        const quiz = await Quiz.findById(module.quiz);
        if (quiz) {
          await Question.deleteMany({ quizId: quiz._id });
          await Quiz.findByIdAndDelete(quiz._id);
        }
      }
    }
    await Module.deleteMany({ courseId: courseId });

    if (course.finalExam) {
      const exam = await Quiz.findById(course.finalExam);
      if (exam) {
        await Question.deleteMany({ quizId: exam._id });
        await Quiz.findByIdAndDelete(exam._id);
      }
    }

    // Delete the course
    await Course.findByIdAndDelete(courseId);

    res.json({ message: 'Course deleted successfully' });
  } catch (error) {
    console.error('Error deleting course:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST publish a course
router.post('/:id/publish', requireCreatorUser, async (req, res) => {
  try {
    const course = await Course.findOne({
      _id: req.params.id,
      instructorId: req.user.userId,
    });
    if (!course) {
      return res.status(404).json({ error: 'Course not found' });
    }

    assertUserCanPublishCoursePublicly(req.user, req.platformAccess);
    course.status = 'published';
    course.enrollmentOpen = true;
    await ensurePublishedPaidCourseHasProvider(course);
    await syncCourseStripeData(course);
    await course.save();

    res.json({ course });
  } catch (error) {
    return respondWithError(res, error);
  }
});

// POST unpublish a course
router.post('/:id/unpublish', requireCreatorUser, async (req, res) => {
  try {
    const course = await Course.findOne({
      _id: req.params.id,
      instructorId: req.user.userId,
    });
    if (!course) {
      return res.status(404).json({ error: 'Course not found' });
    }

    course.status = 'draft';
    await syncCourseStripeData(course);
    await course.save();

    res.json({ course });
  } catch (error) {
    return respondWithError(res, error);
  }
});

module.exports = router;
