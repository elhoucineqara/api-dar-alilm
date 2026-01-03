const mongoose = require('mongoose');
const dotenv = require('dotenv');
const About = require('./models/About');
const connectDB = require('./lib/db');

// Load environment variables
dotenv.config();

const defaultAboutData = {
  title: 'About Dar Al-Ilm',
  subtitle: 'Your Trusted Partner in Online Learning',
  description: 'Dar Al-Ilm is a comprehensive learning management system designed to deliver high-quality education to students worldwide. We believe in making education accessible, affordable, and effective for everyone, regardless of their location or background.',
  mission: 'To provide accessible, affordable, and high-quality education to learners around the globe, empowering them with the knowledge and skills they need to succeed in their personal and professional lives.',
  vision: 'To become the leading platform for online education and skill development, recognized for our innovative teaching methods, engaging content, and commitment to student success.',
  values: [
    {
      title: 'Excellence',
      description: 'We strive for excellence in everything we do, from course content to student support.',
      icon: '⭐',
    },
    {
      title: 'Innovation',
      description: 'We embrace new technologies and teaching methods to enhance the learning experience.',
      icon: '💡',
    },
    {
      title: 'Accessibility',
      description: 'We make quality education accessible to everyone, breaking down barriers to learning.',
      icon: '🌍',
    },
    {
      title: 'Community',
      description: 'We foster a supportive learning community where students and instructors can connect and grow together.',
      icon: '🤝',
    },
    {
      title: 'Integrity',
      description: 'We maintain the highest standards of academic integrity and ethical conduct.',
      icon: '✅',
    },
    {
      title: 'Growth',
      description: 'We are committed to continuous improvement and lifelong learning for all our stakeholders.',
      icon: '📈',
    },
  ],
  stats: [
    {
      label: 'Active Students',
      value: '10,000+',
      icon: '👨‍🎓',
    },
    {
      label: 'Courses Available',
      value: '500+',
      icon: '📚',
    },
    {
      label: 'Expert Instructors',
      value: '200+',
      icon: '👩‍🏫',
    },
    {
      label: 'Countries Reached',
      value: '50+',
      icon: '🌎',
    },
  ],
  team: [
    {
      name: 'Dr. Ahmed Hassan',
      role: 'Founder & CEO',
      bio: 'Passionate about making education accessible to all.',
      social: {
        email: 'ahmed@daralilm.com',
      },
    },
    {
      name: 'Sarah Johnson',
      role: 'Head of Education',
      bio: 'Dedicated to creating engaging learning experiences.',
      social: {
        email: 'sarah@daralilm.com',
      },
    },
    {
      name: 'Mohamed Ali',
      role: 'Technical Director',
      bio: 'Building innovative solutions for modern education.',
      social: {
        email: 'mohamed@daralilm.com',
      },
    },
    {
      name: 'Lisa Chen',
      role: 'Student Success Manager',
      bio: 'Ensuring every student achieves their learning goals.',
      social: {
        email: 'lisa@daralilm.com',
      },
    },
  ],
  isActive: true,
};

async function seedAboutPage() {
  try {
    // Connect to database
    await connectDB();
    console.log('MongoDB connected successfully');

    // Check if about page already exists
    const existingAbout = await About.findOne({ isActive: true });
    
    if (existingAbout) {
      console.log('Active about page already exists. Skipping seed.');
      console.log('If you want to update it, delete the existing page first or use the API.');
    } else {
      // Create new about page
      const about = new About(defaultAboutData);
      await about.save();
      console.log('About page seeded successfully!');
    }

    process.exit(0);
  } catch (error) {
    console.error('Error seeding about page:', error);
    process.exit(1);
  }
}

seedAboutPage();

