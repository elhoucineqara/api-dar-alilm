const express = require('express');
const router = express.Router();
const Course = require('../models/Course');
const Module = require('../models/Module');
const Section = require('../models/Section');
const Quiz = require('../models/Quiz');
const Question = require('../models/Question');
const Answer = require('../models/Answer');
const Enrollment = require('../models/Enrollment');
const { getAuthContextFromToken } = require('../lib/request-auth');

// GET a single quiz by ID (requires authentication - checks enrollment for students or ownership for instructors)
router.get('/:id', async (req, res) => {
  try {
    const quizId = req.params.id;
    
    // Check authentication
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const token = authHeader.substring(7);
    let authUser;
    try {
      const context = await getAuthContextFromToken(token);
      authUser = context.authUser;
    } catch (error) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    // Find the quiz
    let quiz = await Quiz.findById(quizId)
      .populate({
        path: 'questions',
        populate: { path: 'answers' },
        options: { sort: { order: 1 } }
      })
      .lean();
    
    if (!quiz) {
      return res.status(404).json({ error: 'Quiz not found' });
    }

    // Transform questions to match frontend expectations (question -> text, answer -> text)
    if (quiz.questions && Array.isArray(quiz.questions)) {
      quiz.questions = quiz.questions.map((q) => ({
        ...q,
        text: q.question || q.text, // Map question field to text
        answers: (q.answers || []).map((a) => ({
          ...a,
          text: a.answer || a.text, // Map answer field to text
        }))
      }));
    }

    // Find which course this quiz belongs to
    let course = null;
    let courseId = null;
    
    // First check if quiz has courseId directly
    if (quiz.courseId) {
      courseId = quiz.courseId.toString();
      course = await Course.findById(quiz.courseId).lean();
    } else {
      // Check if it's a module quiz
      const module = await Module.findOne({ quiz: quizId }).lean();
      if (module) {
        courseId = module.courseId.toString();
        course = await Course.findById(module.courseId).lean();
      } else {
        const section = await Section.findOne({ quizId }).lean();
        if (section) {
          const sectionModule = await Module.findById(section.moduleId).lean();
          if (sectionModule) {
            courseId = sectionModule.courseId.toString();
            course = await Course.findById(sectionModule.courseId).lean();
          }
        }

        if (!course) {
          // Check if it's a final exam
          course = await Course.findOne({ finalExam: quizId }).lean();
          if (course) {
            courseId = course._id.toString();
          }
        }
      }
    }

    if (!course) {
      return res.status(404).json({ error: 'Course not found for this quiz' });
    }

    // Check authorization
    if (authUser.role === 'admin') {
      // Admins can inspect any quiz on the platform
    } else if (authUser.role === 'instructor') {
      // Instructors can only access quizzes for their own courses
      if (course.instructorId.toString() !== authUser.userId) {
        return res.status(403).json({ error: 'Forbidden: You do not own this course' });
      }
    } else if (authUser.role === 'student') {
      // Students can only access quizzes for courses they're enrolled in
      const enrollment = await Enrollment.findOne({
        userId: authUser.userId,
        courseId: course._id
      }).lean();
      
      if (!enrollment) {
        if (course.status !== 'published' || course.enrollmentOpen === false) {
          return res.status(404).json({ error: 'Quiz not found' });
        }

        // Check if course is free
        if (course.price && course.price > 0) {
          return res.status(403).json({ error: 'Forbidden: You must be enrolled in this course' });
        }
      }
    } else {
      return res.status(403).json({ error: 'Forbidden: Invalid role' });
    }
    
    // Add courseId to quiz response for easier access
    res.json({ quiz: { ...quiz, courseId } });
  } catch (error) {
    console.error('Error fetching quiz:', error);
    if (error.name === 'CastError') {
      return res.status(400).json({ error: 'Invalid quiz ID' });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;

