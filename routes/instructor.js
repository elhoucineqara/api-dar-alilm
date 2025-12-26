const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Course = require('../models/Course');
const Category = require('../models/Category');
const Enrollment = require('../models/Enrollment');
const { verifyToken } = require('../lib/jwt');

const Module = require('../models/Module');
const Section = require('../models/Section');
const Progress = require('../models/Progress');

// Middleware to protect instructor routes
const isInstructor = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const token = authHeader.substring(7);
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

// PUT update instructor profile
router.put('/profile', isInstructor, async (req, res) => {
  try {
    const { firstName, lastName, email, phone, bio, profileImage } = req.body;
    
    const user = await User.findById(req.user.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Update fields
    if (firstName) user.firstName = firstName;
    if (lastName) user.lastName = lastName;
    if (email) user.email = email;
    if (phone !== undefined) user.phone = phone;
    if (bio !== undefined) user.bio = bio;
    if (profileImage !== undefined) user.profileImage = profileImage;

    await user.save();

    // Return updated user
    res.json({
      user: {
        id: user._id.toString(),
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        phone: user.phone,
        bio: user.bio,
        profileImage: user.profileImage,
      }
    });
  } catch (error) {
    console.error('Error updating profile:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET all categories for the instructor
router.get('/categories', isInstructor, async (req, res) => {
  try {
    const categories = await Category.find({ instructorId: req.user.userId }).sort({ createdAt: -1 });
    res.json({ categories });
  } catch (error) {
    console.error('Error fetching categories:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST create a new category
router.post('/categories', isInstructor, async (req, res) => {
  try {
    const { name, description } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'Category name is required' });
    }

    const category = new Category({
      name,
      description,
      instructorId: req.user.userId,
    });

    await category.save();
    res.status(201).json({ category });
  } catch (error) {
    console.error('Error creating category:', error);
    if (error.code === 11000) {
      return res.status(400).json({ error: 'Category name already exists' });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT update a category
router.put('/categories/:id', isInstructor, async (req, res) => {
  try {
    const { name, description } = req.body;
    const categoryId = req.params.id;

    if (!name) {
      return res.status(400).json({ error: 'Category name is required' });
    }

    const category = await Category.findOne({ _id: categoryId, instructorId: req.user.userId });
    if (!category) {
      return res.status(404).json({ error: 'Category not found' });
    }

    category.name = name;
    category.description = description;
    await category.save();

    res.json({ category });
  } catch (error) {
    console.error('Error updating category:', error);
    if (error.code === 11000) {
      return res.status(400).json({ error: 'Category name already exists' });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE a category
router.delete('/categories/:id', isInstructor, async (req, res) => {
  try {
    const categoryId = req.params.id;

    const category = await Category.findOne({ _id: categoryId, instructorId: req.user.userId });
    if (!category) {
      return res.status(404).json({ error: 'Category not found' });
    }

    // Check if category is used by any courses
    const coursesUsingCategory = await Course.countDocuments({ categoryId });
    if (coursesUsingCategory > 0) {
      return res.status(400).json({ 
        error: `Cannot delete category. It is used by ${coursesUsingCategory} course(s)` 
      });
    }

    await Category.findByIdAndDelete(categoryId);
    res.json({ message: 'Category deleted successfully' });
  } catch (error) {
    console.error('Error deleting category:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET instructor statistics
router.get('/statistics', isInstructor, async (req, res) => {
  try {
    const instructorId = req.user.userId;

    const totalCourses = await Course.countDocuments({ instructorId });
    const publishedCourses = await Course.countDocuments({ instructorId, status: 'published' });

    const instructorCourses = await Course.find({ instructorId }).select('_id');
    const courseIds = instructorCourses.map((course) => course._id);

    const totalEnrollments = await Enrollment.countDocuments({ courseId: { $in: courseIds } });
    const enrollments = await Enrollment.find({ courseId: { $in: courseIds } }).distinct('userId');
    const totalStudents = enrollments.length;

    res.json({
      statistics: {
        totalCourses,
        publishedCourses,
        draftCourses: totalCourses - publishedCourses,
        totalStudents,
        totalEnrollments,
      },
    });
  } catch (error) {
    console.error('Error fetching statistics:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET all students for the instructor's courses
router.get('/students', isInstructor, async (req, res) => {
  try {
    const instructorId = req.user.userId;
    const { courseId } = req.query;

    const instructorCourses = await Course.find({ instructorId }).select('_id');
    const courseIds = instructorCourses.map((c) => c._id);

    let enrollmentQuery = { courseId: { $in: courseIds } };
    if (courseId && courseId !== 'all') {
      enrollmentQuery.courseId = courseId;
    }

    const enrollments = await Enrollment.find(enrollmentQuery).populate('userId');
    const studentIds = [...new Set(enrollments.map((e) => e.userId._id.toString()))];

    const studentsData = await Promise.all(
      studentIds.map(async (studentId) => {
        const student = await User.findById(studentId);
        if (!student) return null;

        const studentEnrollments = enrollments.filter(
          (e) => e.userId._id.toString() === studentId
        );

        const progressData = await Promise.all(
          studentEnrollments.map(async (enrollment) => {
            const progress = await Progress.findOne({
              userId: studentId,
              courseId: enrollment.courseId,
            });
            return progress?.overallProgress || 0;
          })
        );

        const totalProgress =
          progressData.length > 0
            ? progressData.reduce((sum, p) => sum + p, 0) / progressData.length
            : 0;

        const lastProgress = await Progress.findOne({ userId: studentId })
          .sort({ lastAccessedAt: -1 })
          .select('lastAccessedAt');

        return {
          _id: student._id,
          firstName: student.firstName,
          lastName: student.lastName,
          email: student.email,
          enrolledCourses: studentEnrollments.length,
          totalProgress: Math.round(totalProgress),
          lastActive: lastProgress?.lastAccessedAt || student.createdAt,
        };
      })
    );

    const students = studentsData
      .filter((s) => s !== null)
      .sort((a, b) =>
        `${a.firstName} ${a.lastName}`.localeCompare(`${b.firstName} ${b.lastName}`)
      );

    res.json({ students });
  } catch (error) {
    console.error('Error fetching students:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET detailed student data for an instructor
router.get('/students/:id', isInstructor, async (req, res) => {
  try {
    const studentId = req.params.id;
    const instructorId = req.user.userId;

    const student = await User.findById(studentId).select('-password');
    if (!student) {
      return res.status(404).json({ error: 'Student not found' });
    }

    const instructorCourses = await Course.find({ instructorId });
    const courseIds = instructorCourses.map((c) => c._id);

    const enrollments = await Enrollment.find({
      userId: studentId,
      courseId: { $in: courseIds },
    }).populate('courseId');

    const coursesProgress = await Promise.all(
      enrollments.map(async (enrollment) => {
        const course = enrollment.courseId;
        const progress = await Progress.findOne({
          userId: studentId,
          courseId: course._id,
        });

        const modules = await Module.find({ courseId: course._id });
        const totalSections = modules.reduce((sum, m) => sum + (m.sections?.length || 0), 0);
        // Modules usually have quizId directly in the model now, let's check
        const totalQuizzes = modules.filter(m => m.quiz).length;

        return {
          courseId: course._id,
          courseTitle: course.title,
          overallProgress: progress?.overallProgress || 0,
          completedSections: progress?.completedSections?.length || 0,
          totalSections,
          completedQuizzes: progress?.completedQuizzes?.length || 0,
          totalQuizzes,
          completedFinalExam: progress?.completedFinalExam || false,
          lastAccessedAt: progress?.lastAccessedAt || enrollment.enrolledAt,
          enrolledAt: enrollment.enrolledAt,
        };
      })
    );

    res.json({
      student: {
        _id: student._id,
        firstName: student.firstName,
        lastName: student.lastName,
        email: student.email,
        createdAt: student.createdAt,
      },
      courses: coursesProgress,
    });
  } catch (error) {
    console.error('Error fetching student details:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET analytics data for instructor
router.get('/analytics', isInstructor, async (req, res) => {
  try {
    const instructorId = req.user.userId;

    // Get all courses by instructor
    const courses = await Course.find({ instructorId });
    const courseIds = courses.map(c => c._id);

    // Get total enrollments
    const enrollments = await Enrollment.find({ courseId: { $in: courseIds } });
    const activeEnrollments = enrollments.filter(e => e.status === 'active').length;

    // Get unique students
    const uniqueStudents = new Set(enrollments.map(e => e.userId?.toString()).filter(Boolean));
    const totalStudents = uniqueStudents.size;

    // Calculate total revenue (assuming course price * enrollments)
    let totalRevenue = 0;
    const coursesData = [];

    for (const course of courses) {
      const courseEnrollments = enrollments.filter(e => e.courseId.toString() === course._id.toString());
      const revenue = course.price * courseEnrollments.length;
      totalRevenue += revenue;

      // Calculate completion rate
      const completedEnrollments = courseEnrollments.filter(e => e.progress === 100).length;
      const completionRate = courseEnrollments.length > 0 
        ? Math.round((completedEnrollments / courseEnrollments.length) * 100) 
        : 0;

      coursesData.push({
        _id: course._id,
        title: course.title,
        enrollments: courseEnrollments.length,
        completionRate,
        revenue,
      });
    }

    // Sort courses by enrollments
    coursesData.sort((a, b) => b.enrollments - a.enrollments);

    res.json({
      totalStudents,
      totalCourses: courses.length,
      totalRevenue,
      activeEnrollments,
      coursesData,
    });
  } catch (error) {
    console.error('Error fetching analytics:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET forum posts for instructor's courses
router.get('/forum', isInstructor, async (req, res) => {
  try {
    const instructorId = req.user.userId;

    // Get all courses by instructor
    const courses = await Course.find({ instructorId }).select('_id');
    const courseIds = courses.map(c => c._id);

    // Import ForumPost model
    const ForumPost = require('../models/ForumPost');

    // Get all forum posts related to instructor's courses or created by instructor
    const posts = await ForumPost.find({
      $or: [
        { courseId: { $in: courseIds } },
        { authorId: instructorId }
      ]
    })
      .populate('authorId', 'firstName lastName profileImage')
      .populate('courseId', 'title')
      .sort({ createdAt: -1 })
      .lean();

    // Transform data to match frontend interface
    const transformedPosts = posts.map(post => ({
      ...post,
      author: post.authorId,
      replies: post.replies?.length || 0,
    }));

    res.json({ posts: transformedPosts });
  } catch (error) {
    console.error('Error fetching forum posts:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
