const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const connectDB = require('./lib/db');

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors({
  origin: true, // Allow all origins
  credentials: true,
  exposedHeaders: ['Content-Type', 'Content-Disposition', 'Content-Length']
}));

// Skip body parsing for upload routes - let multer handle it
app.use((req, res, next) => {
  if (req.path.includes('/upload')) {
    // Skip body parsing for upload routes
    return next();
  }
  // Apply body parsers for other routes
  express.json({ limit: '50mb', type: 'application/json' })(req, res, next);
});

app.use((req, res, next) => {
  if (req.path.includes('/upload')) {
    return next();
  }
  express.urlencoded({ limit: '50mb', extended: true })(req, res, next);
});

// Routes
const authRoutes = require('./routes/auth');
const courseRoutes = require('./routes/courses');
const publicCoursesRoutes = require('./routes/public-courses');
const instructorRoutes = require('./routes/instructor');
const studentRoutes = require('./routes/student');
const forumRoutes = require('./routes/forum');
const moduleRoutes = require('./routes/modules');
const uploadRoutes = require('./routes/upload');
const sectionRoutes = require('./routes/sections');
const quizRoutes = require('./routes/quizzes');
const filesRoutes = require('./routes/files');

app.use('/api/auth', authRoutes);
app.use('/api/courses', publicCoursesRoutes); // Public courses route (no auth required)
app.use('/api/instructor/courses', courseRoutes);
app.use('/api/instructor/modules', moduleRoutes);
app.use('/api/instructor/sections', sectionRoutes);
app.use('/api/instructor/quizzes', quizRoutes);
app.use('/api/instructor/upload', uploadRoutes);
app.use('/api/instructor', instructorRoutes);
app.use('/api/student', studentRoutes);
app.use('/api/forum', forumRoutes);
app.use('/api/files', filesRoutes); // Public files route (no auth required)

// Basic route
app.get('/', (req, res) => {
  res.send('LMS API is running...');
});

// Start server after connecting to database
async function startServer() {
  try {
    // Connect to Database first
    await connectDB();
    console.log('MongoDB connected successfully');
    
    // Then start the server
    app.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
    });
  } catch (error) {
    console.error('Failed to connect to MongoDB:', error);
    process.exit(1);
  }
}

startServer();
