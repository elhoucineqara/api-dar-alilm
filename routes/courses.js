const express = require('express');
const router = express.Router();
const Course = require('../models/Course');
const Category = require('../models/Category');
const Enrollment = require('../models/Enrollment');
const { verifyToken } = require('../lib/jwt');

// Middleware to protect instructor routes
const isInstructor = async (req, res, next) => {
  try {
    const token = req.headers.get ? req.headers.get('authorization')?.replace('Bearer ', '') : req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const decoded = verifyToken(token);
    if (decoded.role !== 'instructor') {
      return res.status(403).json({ error: 'Forbidden' });
    }

    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
};

// GET all courses for the instructor
router.get('/', isInstructor, async (req, res) => {
  try {
    const courses = await Course.find({ instructorId: req.user.userId })
      .populate('categoryId', 'name')
      .sort({ createdAt: -1 });
    
    // Add student count to each course
    const coursesWithStats = await Promise.all(
      courses.map(async (course) => {
        const studentsCount = await Enrollment.countDocuments({ courseId: course._id });
        return {
          ...course.toObject(),
          studentsCount,
        };
      })
    );
    
    res.json({ courses: coursesWithStats });
  } catch (error) {
    console.error('Error fetching courses:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST create a new course
router.post('/', isInstructor, async (req, res) => {
  try {
    const { title, description, categoryId, price, thumbnail, status } = req.body;

    if (!title || !description || !categoryId) {
      return res.status(400).json({ error: 'Title, description, and category are required' });
    }

    // Verify category exists
    const category = await Category.findOne({ _id: categoryId });
    if (!category) {
      return res.status(404).json({ error: 'Category not found' });
    }

    const course = new Course({
      title,
      description,
      categoryId,
      instructorId: req.user.userId,
      price: price || 0,
      thumbnail,
      status: status || 'draft',
      modules: [],
    });

    await course.save();
    res.status(201).json({ course });
  } catch (error) {
    console.error('Error creating course:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const Module = require('../models/Module');
const Section = require('../models/Section');
const Quiz = require('../models/Quiz');
const Question = require('../models/Question');
const Answer = require('../models/Answer');

// GET a single course with modules
router.get('/:id', isInstructor, async (req, res) => {
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
router.get('/:id/training', isInstructor, async (req, res) => {
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
        trainingContent.push({
          type: 'section',
          _id: section._id,
          title: section.title,
          moduleId: module._id,
          moduleTitle: module.title,
          order: section.order,
          data: section
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
router.put('/:id', isInstructor, async (req, res) => {
  try {
    const courseId = req.params.id;
    const { title, description, categoryId, price, thumbnail, status } = req.body;

    if (categoryId) {
      const category = await Category.findOne({ _id: categoryId });
      if (!category) {
        return res.status(404).json({ error: 'Category not found' });
      }
    }

    const updateData = {};
    if (title) updateData.title = title;
    if (description) updateData.description = description;
    if (categoryId) updateData.categoryId = categoryId;
    if (price !== undefined) updateData.price = price;
    if (thumbnail !== undefined) updateData.thumbnail = thumbnail;
    if (status) updateData.status = status;

    const course = await Course.findOneAndUpdate(
      { _id: courseId, instructorId: req.user.userId },
      updateData,
      { new: true, runValidators: true }
    );

    if (!course) {
      return res.status(404).json({ error: 'Course not found' });
    }

    res.json({ course });
  } catch (error) {
    console.error('Error updating course:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE a course
router.delete('/:id', isInstructor, async (req, res) => {
  try {
    const courseId = req.params.id;
    const course = await Course.findOne({ _id: courseId, instructorId: req.user.userId });
    if (!course) {
      return res.status(404).json({ error: 'Course not found' });
    }

    // Delete associated sections and modules
    const modules = await Module.find({ courseId: courseId });
    for (const module of modules) {
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
router.post('/:id/publish', isInstructor, async (req, res) => {
  try {
    const course = await Course.findOneAndUpdate(
      { _id: req.params.id, instructorId: req.user.userId },
      { status: 'published' },
      { new: true }
    );
    if (!course) {
      return res.status(404).json({ error: 'Course not found' });
    }
    res.json({ course });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST unpublish a course
router.post('/:id/unpublish', isInstructor, async (req, res) => {
  try {
    const course = await Course.findOneAndUpdate(
      { _id: req.params.id, instructorId: req.user.userId },
      { status: 'draft' },
      { new: true }
    );
    if (!course) {
      return res.status(404).json({ error: 'Course not found' });
    }
    res.json({ course });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
