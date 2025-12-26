const express = require('express');
const router = express.Router();
const Course = require('../models/Course');
const Module = require('../models/Module');
const Section = require('../models/Section');
const Quiz = require('../models/Quiz');
const Question = require('../models/Question');
const Answer = require('../models/Answer');

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

