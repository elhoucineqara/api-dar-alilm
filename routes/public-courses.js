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

// GET public statistics (no auth required) - MUST BE BEFORE /:id route
router.get('/statistics', async (req, res) => {
  try {
    // Count published courses
    const totalCourses = await Course.countDocuments({ status: 'published' });
    console.log('Total published courses:', totalCourses);
    
    // Count unique students (users who have enrolled in at least one course)
    const uniqueStudents = await Enrollment.distinct('userId');
    const totalStudents = uniqueStudents.length;
    console.log('Total unique students:', totalStudents);
    
    // Count instructors (users with role 'instructor')
    const totalInstructors = await User.countDocuments({ role: 'instructor' });
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
    const categories = await Category.find()
      .select('name description')
      .sort({ name: 1 })
      .lean();
    
    res.json({ categories });
  } catch (error) {
    console.error('Error fetching categories:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET section details for free courses (public - no auth required)
router.get('/sections/:id', async (req, res) => {
  try {
    const sectionId = req.params.id;
    
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
    
    // Only allow access if course is free (price = 0 or null) and published
    if (course.price && course.price > 0) {
      return res.status(403).json({ error: 'This section requires enrollment' });
    }
    
    if (course.status !== 'published') {
      return res.status(403).json({ error: 'Course is not published' });
    }
    
    res.json(section);
  } catch (error) {
    console.error('Error fetching section:', error);
    if (error.name === 'CastError') {
      return res.status(400).json({ error: 'Invalid section ID' });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET all published courses (public - no auth required)
router.get('/', async (req, res) => {
  try {
    const { limit, skip, categoryId } = req.query;
    
    const query = { status: 'published' };
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
    
    const course = await Course.findOne({ 
      _id: courseId,
      status: 'published'
    })
      .populate('categoryId', 'name')
      .populate('instructorId', 'firstName lastName email profileImage')
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
      try {
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
      } catch (error) {
        console.error('Error loading final exam:', error);
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

module.exports = router;

