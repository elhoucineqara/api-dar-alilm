const express = require('express');
const router = express.Router();
const Course = require('../models/Course');
const Category = require('../models/Category');
const Module = require('../models/Module');
const Section = require('../models/Section');
const Quiz = require('../models/Quiz');
const Question = require('../models/Question');
const Answer = require('../models/Answer');
const User = require('../models/User');
const Enrollment = require('../models/Enrollment');
const {
  assertCourseIsPubliclyVisible,
  getPublicCourseQuery,
} = require('../lib/creator-access');
const { userCanAccessCourse } = require('../lib/course-access');
const { ensureDefaultCategories } = require('../lib/category-catalog');
const { getPlatformSettings } = require('../lib/platform-settings');
const { getOptionalAuthUser } = require('../lib/request-auth');
const { getInstructorPaymentProviderAvailability } = require('../lib/user-payment-settings');

async function loadQuizWithQuestions(quizId) {
  if (!quizId) {
    return null;
  }

  const quiz = await Quiz.findById(quizId).lean();
  if (!quiz) {
    return null;
  }

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

async function loadModulesWithContent(courseId) {
  const modulesData = await Module.find({ courseId })
    .sort({ order: 1 })
    .lean();

  return Promise.all(
    modulesData.map(async (module) => {
      let sections = [];
      if (module.sections && module.sections.length > 0) {
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
      }

      const quiz = module.quiz ? await loadQuizWithQuestions(module.quiz) : null;

      return { ...module, sections, quiz };
    })
  );
}

async function loadCoursePreview(courseId) {
  const course = await Course.findOne({
    _id: courseId,
    status: 'published',
  })
    .populate('categoryId', 'name')
    .populate('instructorId', 'firstName lastName email profileImage paymentSettings role accountStatus')
    .lean();

  if (!course) {
    return null;
  }

  await assertCourseIsPubliclyVisible(course, { owner: course.instructorId });

  const instructor = course.instructorId
    ? {
        _id: course.instructorId._id,
        firstName: course.instructorId.firstName,
        lastName: course.instructorId.lastName,
        email: course.instructorId.email,
        profileImage: course.instructorId.profileImage,
      }
    : null;
  const paymentProviders = getInstructorPaymentProviderAvailability(course.instructorId || {});

  const modulesData = await Module.find({ courseId })
    .sort({ order: 1 })
    .select('title description order quiz')
    .lean();

  let lessonsCount = 0;
  const modules = await Promise.all(
    modulesData.map(async (module) => {
      const [sectionsCount, quizSectionsCount] = await Promise.all([
        Section.countDocuments({ moduleId: module._id }),
        Section.countDocuments({ moduleId: module._id, type: 'quiz' }),
      ]);
      lessonsCount += sectionsCount;

      return {
        _id: module._id,
        title: module.title,
        description: module.description,
        order: module.order,
        sectionsCount,
        hasQuiz: Boolean(module.quiz || quizSectionsCount > 0),
      };
    })
  );

  return {
    _id: course._id,
    title: course.title,
    description: course.description,
    price: course.price || 0,
    thumbnail: course.thumbnail,
    category: course.categoryId || null,
    instructor,
    modulesCount: modules.length,
    lessonsCount,
    hasFinalExam: Boolean(course.finalExam),
    isFree: !course.price || course.price === 0,
    paymentProviders,
    modules,
  };
}

async function loadFullCourse(courseId, options = {}) {
  const course = await Course.findOne({
    _id: courseId,
    status: 'published',
  })
    .populate('categoryId', 'name')
    .populate('instructorId', 'firstName lastName email profileImage paymentSettings role accountStatus')
    .lean();

  if (!course) {
    return null;
  }

  await assertCourseIsPubliclyVisible(course, {
    owner: course.instructorId,
    requireEnrollmentOpen: options.requireEnrollmentOpen,
  });

  const [modules, finalExam] = await Promise.all([
    loadModulesWithContent(courseId),
    loadQuizWithQuestions(course.finalExam),
  ]);
  const paymentProviders = getInstructorPaymentProviderAvailability(course.instructorId || {});

  return {
    ...course,
    instructorId: course.instructorId
      ? {
          _id: course.instructorId._id,
          firstName: course.instructorId.firstName,
          lastName: course.instructorId.lastName,
          email: course.instructorId.email,
          profileImage: course.instructorId.profileImage,
        }
      : course.instructorId,
    paymentProviders,
    modules,
    finalExam,
  };
}

// GET public statistics (no auth required) - MUST BE BEFORE /:id route
router.get('/statistics', async (req, res) => {
  try {
    const settings = await getPlatformSettings();
    const publicCourseQuery = await getPublicCourseQuery(settings);

    // Count published courses available on the public catalog
    const totalCourses = await Course.countDocuments(publicCourseQuery);
    console.log('Total published courses:', totalCourses);
    
    // Count unique students (users who have enrolled in at least one course)
    const uniqueStudents = await Enrollment.distinct('userId');
    const totalStudents = uniqueStudents.length;
    console.log('Total unique students:', totalStudents);
    
    // Count public sellers currently represented in the catalog.
    const totalInstructors = (
      await Course.distinct('instructorId', publicCourseQuery)
    ).length;
    console.log('Total instructors:', totalInstructors);
    
    // Also count all users with role 'student' as fallback
    const allStudents = await User.countDocuments({ role: 'student' });
    console.log('All students in User model:', allStudents);
    
    const statistics = {
      totalStudents: totalStudents > 0 ? totalStudents : allStudents,
      totalCourses,
      totalInstructors,
    };
    
    console.log('Returning statistics:', statistics);
    
    res.json({
      statistics,
    });
  } catch (error) {
    console.error('Error fetching public statistics:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

// GET all categories (public - no auth required)
router.get('/categories', async (req, res) => {
  try {
    const categories = await ensureDefaultCategories();

    res.json({
      categories: categories.map((category) => ({
        _id: category._id,
        name: category.name,
        description: category.description,
      })),
    });
  } catch (error) {
    console.error('Error fetching categories:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET section details for published courses that the current user can access
router.get('/sections/:id', async (req, res) => {
  try {
    const sectionId = req.params.id;
    const requestUser = await getOptionalAuthUser(req);
    const settings = await getPlatformSettings();
    
    // Find the section
    const section = await Section.findById(sectionId).lean();
    
    if (!section) {
      return res.status(404).json({ error: 'Section not found' });
    }
    
    // Find the module and course
    const module = await Module.findById(section.moduleId).lean();
    if (!module) {
      return res.status(404).json({ error: 'Module not found' });
    }
    
    const course = await Course.findById(module.courseId).lean();
    if (!course) {
      return res.status(404).json({ error: 'Course not found' });
    }

    const hasAccess = await userCanAccessCourse({
      user: requestUser,
      course,
    });

    if (!hasAccess) {
      if (course.enrollmentOpen === false) {
        return res.status(404).json({ error: 'Section not found' });
      }

      return res.status(403).json({
        error: !requestUser
          ? 'Please log in or create an account to access this section.'
          : course.price && course.price > 0
            ? 'This section requires payment and enrollment.'
            : 'This section requires enrollment.',
        requiresPurchase: Boolean(course.price && course.price > 0),
        requiresLogin: !requestUser,
      });
    }

    await assertCourseIsPubliclyVisible(course, {
      settings,
      requireEnrollmentOpen: false,
    });
    
    res.json(section);
  } catch (error) {
    console.error('Error fetching section:', error);
    if (error.name === 'CastError') {
      return res.status(400).json({ error: 'Invalid section ID' });
    }
    res.status(error.statusCode || 500).json({ error: error.message || 'Internal server error' });
  }
});

router.get('/preview/:id', async (req, res) => {
  try {
    const preview = await loadCoursePreview(req.params.id);

    if (!preview) {
      return res.status(404).json({ error: 'Course not found' });
    }

    res.json({ course: preview });
  } catch (error) {
    console.error('Error fetching course preview:', error);
    if (error.name === 'CastError') {
      return res.status(400).json({ error: 'Invalid course ID' });
    }
    res.status(error.statusCode || 500).json({ error: error.message || 'Internal server error' });
  }
});

// GET all published courses (public - no auth required)
router.get('/', async (req, res) => {
  try {
    const { limit, skip, categoryId } = req.query;

    const query = await getPublicCourseQuery(await getPlatformSettings());
    if (categoryId) {
      query.categoryId = categoryId;
    }

    const limitNum = parseInt(limit) || 12;
    const skipNum = parseInt(skip) || 0;

    const courses = await Course.find(query)
      .populate('categoryId', 'name')
      .populate('instructorId', 'firstName lastName profileImage')
      .sort({ createdAt: -1 })
      .skip(skipNum)
      .limit(limitNum)
      .lean();

    const total = await Course.countDocuments(query);

    res.json({ 
      courses,
      total,
      limit: limitNum,
      skip: skipNum
    });
  } catch (error) {
    console.error('Error fetching published courses:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET a single published course by ID (public - no auth required)
router.get('/:id', async (req, res) => {
  try {
    const courseId = req.params.id;
    const requestUser = await getOptionalAuthUser(req);
    const settings = await getPlatformSettings();
    const course = await Course.findOne({
      _id: courseId,
      status: 'published',
    }).lean();

    if (!course) {
      return res.status(404).json({ error: 'Course not found' });
    }

    await assertCourseIsPubliclyVisible(course, {
      settings,
      requireEnrollmentOpen: false,
    });

    const hasAccess = await userCanAccessCourse({
      user: requestUser,
      course,
    });

    if (!hasAccess) {
      if (course.enrollmentOpen === false) {
        return res.status(404).json({ error: 'Course not found' });
      }

      return res.status(403).json({
        error: !requestUser
          ? 'Please log in or create an account to access this course.'
          : course.price && course.price > 0
            ? 'This course requires payment and enrollment.'
            : 'This course requires enrollment.',
        requiresPurchase: Boolean(course.price && course.price > 0),
        requiresLogin: !requestUser,
        courseId,
      });
    }

    const fullCourse = await loadFullCourse(courseId, {
      requireEnrollmentOpen: false,
    });

    res.json({
      course: fullCourse,
    });
  } catch (error) {
    console.error('Error fetching course:', error);
    if (error.name === 'CastError') {
      return res.status(400).json({ error: 'Invalid course ID' });
    }
    res.status(error.statusCode || 500).json({ error: error.message || 'Internal server error' });
  }
});

module.exports = router;

