const express = require('express');
const router = express.Router();
const Enrollment = require('../models/Enrollment');
const Progress = require('../models/Progress');
const Course = require('../models/Course');
const Category = require('../models/Category');
const User = require('../models/User');
const Section = require('../models/Section');
const Module = require('../models/Module');
const Quiz = require('../models/Quiz');
const { verifyToken } = require('../lib/jwt');

// Middleware to protect student routes
const isStudent = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const token = authHeader.substring(7);
    const decoded = verifyToken(token);
    if (decoded.role !== 'student') {
      return res.status(403).json({ error: 'Forbidden: Only students can access this' });
    }

    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
};

// GET all enrolled courses for the student
router.get('/courses', isStudent, async (req, res) => {
  try {
    const enrollments = await Enrollment.find({ userId: req.user.userId })
      .sort({ enrolledAt: -1 })
      .lean();

    const coursesWithProgress = await Promise.all(
      enrollments.map(async (enrollment) => {
        const progress = await Progress.findOne({
          userId: req.user.userId,
          courseId: enrollment.courseId,
        }).lean();

        const course = await Course.findById(enrollment.courseId)
          .populate('categoryId', 'name')
          .populate('instructorId', 'firstName lastName')
          .lean();

        return {
          enrollment: {
            _id: enrollment._id,
            enrolledAt: enrollment.enrolledAt,
            status: enrollment.status,
            completedAt: enrollment.completedAt,
          },
          course: {
            _id: course?._id,
            title: course?.title,
            description: course?.description,
            thumbnail: course?.thumbnail,
            price: course?.price,
            category: course?.categoryId,
            instructor: course?.instructorId,
          },
          progress: progress ? {
            overallProgress: progress.overallProgress,
            completedSections: progress.completedSections?.length || 0,
            completedQuizzes: progress.completedQuizzes?.length || 0,
            completedFinalExam: progress.completedFinalExam || false,
            lastAccessedAt: progress.lastAccessedAt,
          } : null,
        };
      })
    );

    res.json({ courses: coursesWithProgress });
  } catch (error) {
    console.error('Error fetching enrolled courses:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET statistics for the student
router.get('/statistics', isStudent, async (req, res) => {
  try {
    const userId = req.user.userId;

    const totalEnrollments = await Enrollment.countDocuments({ userId });
    
    const activeEnrollments = await Enrollment.countDocuments({ 
      userId,
      status: 'active' 
    });

    const completedCourses = await Enrollment.countDocuments({ 
      userId,
      status: 'completed' 
    });

    const allProgress = await Progress.find({ userId }).lean();
    const averageProgress = allProgress.length > 0
      ? Math.round(
          allProgress.reduce((sum, p) => sum + (p.overallProgress || 0), 0) / allProgress.length
        )
      : 0;

    const coursesInProgress = await Progress.countDocuments({
      userId,
      overallProgress: { $gt: 0, $lt: 100 },
    });

    res.json({
      statistics: {
        totalEnrollments,
        activeEnrollments,
        completedCourses,
        coursesInProgress,
        averageProgress,
      },
    });
  } catch (error) {
    console.error('Error fetching student statistics:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET progress for a student
router.get('/progress', isStudent, async (req, res) => {
  try {
    const { courseId } = req.query;

    if (courseId) {
      const progress = await Progress.findOne({
        userId: req.user.userId,
        courseId,
      }).lean();

      if (!progress) {
        return res.status(404).json({ error: 'Progress not found' });
      }

      const course = await Course.findById(courseId)
        .populate('categoryId', 'name')
        .populate('instructorId', 'firstName lastName')
        .lean();

      const modulesData = await Module.find({ courseId }).sort({ order: 1 }).lean();

      const modulesWithProgress = await Promise.all(
        modulesData.map(async (module) => {
          const sections = await Section.find({ moduleId: module._id }).sort({ order: 1 }).lean();
          let quiz = null;
          if (module.quiz) {
            quiz = await Quiz.findById(module.quiz).lean();
          }

          return {
            ...module,
            sections: sections.map((section) => ({
              ...section,
              completed: progress.completedSections?.some((id) => id.toString() === section._id.toString()) || false,
            })),
            quiz: quiz ? {
              ...quiz,
              completed: progress.completedQuizzes?.some((id) => id.toString() === quiz._id.toString()) || false,
            } : null,
          };
        })
      );

      res.json({
        progress: {
          overallProgress: progress.overallProgress,
          completedSections: progress.completedSections,
          completedQuizzes: progress.completedQuizzes,
          completedFinalExam: progress.completedFinalExam,
          lastAccessedAt: progress.lastAccessedAt,
          moduleId: progress.moduleId,
          sectionId: progress.sectionId,
          quizId: progress.quizId,
        },
        course,
        modules: modulesWithProgress,
      });
    } else {
      const allProgress = await Progress.find({ userId: req.user.userId })
        .populate('courseId', 'title thumbnail')
        .sort({ lastAccessedAt: -1 })
        .lean();
      res.json({ progress: allProgress });
    }
  } catch (error) {
    console.error('Error fetching progress:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT update progress
router.put('/progress', isStudent, async (req, res) => {
  try {
    const { courseId, moduleId, sectionId, quizId, completedFinalExam } = req.body;

    if (!courseId) {
      return res.status(400).json({ error: 'Course ID is required' });
    }

    let progress = await Progress.findOne({
      userId: req.user.userId,
      courseId,
    });

    if (!progress) {
      const enrollment = await Enrollment.findOne({
        userId: req.user.userId,
        courseId,
      });

      if (!enrollment) {
        return res.status(400).json({ error: 'Not enrolled in this course' });
      }

      progress = new Progress({
        userId: req.user.userId,
        courseId,
        enrollmentId: enrollment._id,
        completedSections: [],
        completedQuizzes: [],
        completedFinalExam: false,
        overallProgress: 0,
      });
    }

    if (moduleId) progress.moduleId = moduleId;
    if (sectionId) {
      progress.sectionId = sectionId;
      progress.quizId = undefined;
      if (!progress.completedSections.includes(sectionId)) {
        progress.completedSections.push(sectionId);
      }
    }
    if (quizId) {
      progress.quizId = quizId;
      progress.sectionId = undefined;
      if (!progress.completedQuizzes.includes(quizId)) {
        progress.completedQuizzes.push(quizId);
      }
    }

    if (completedFinalExam !== undefined) {
      progress.completedFinalExam = completedFinalExam;
      if (completedFinalExam) progress.quizId = undefined;
    }

    // Calculate overall progress
    const course = await Course.findById(courseId).lean();
    const modules = await Module.find({ courseId }).lean();
    
    let totalSections = 0;
    let totalQuizzes = 0;
    let completedSectionsCount = progress.completedSections.length;
    let completedQuizzesCount = progress.completedQuizzes.length;

    for (const mod of modules) {
      totalSections += await Section.countDocuments({ moduleId: mod._id });
      if (mod.quiz) totalQuizzes += 1;
    }

    if (course?.finalExam) {
      totalQuizzes += 1;
      if (progress.completedFinalExam) completedQuizzesCount += 1;
    }

    const totalItems = totalSections + totalQuizzes;
    const completedItems = completedSectionsCount + completedQuizzesCount;
    
    progress.overallProgress = totalItems > 0 
      ? Math.round((completedItems / totalItems) * 100) 
      : 0;

    progress.lastAccessedAt = new Date();
    await progress.save();

    if (progress.overallProgress === 100) {
      const enrollment = await Enrollment.findOne({ userId: req.user.userId, courseId });
      if (enrollment && enrollment.status === 'active') {
        enrollment.status = 'completed';
        enrollment.completedAt = new Date();
        await enrollment.save();
      }
    }

    res.json({ message: 'Progress updated successfully', progress });
  } catch (error) {
    console.error('Error updating progress:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST enroll in a course
router.post('/enroll', isStudent, async (req, res) => {
  try {
    const { courseId } = req.body;
    const userId = req.user.userId;

    if (!courseId) {
      return res.status(400).json({ error: 'Course ID is required' });
    }

    // Check if course exists
    const course = await Course.findById(courseId);
    if (!course) {
      return res.status(404).json({ error: 'Course not found' });
    }

    // Check if already enrolled
    const existingEnrollment = await Enrollment.findOne({ userId, courseId });
    if (existingEnrollment) {
      return res.status(400).json({ error: 'Already enrolled in this course' });
    }

    // Create enrollment
    const enrollment = new Enrollment({
      userId,
      courseId,
      enrolledAt: new Date(),
      status: 'active',
    });

    await enrollment.save();

    // Create initial progress
    const progress = new Progress({
      userId,
      courseId,
      enrollmentId: enrollment._id,
      completedSections: [],
      completedQuizzes: [],
      completedFinalExam: false,
      overallProgress: 0,
      lastAccessedAt: new Date(),
    });

    await progress.save();

    res.status(201).json({ message: 'Enrolled successfully', enrollment });
  } catch (error) {
    console.error('Error enrolling in course:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
