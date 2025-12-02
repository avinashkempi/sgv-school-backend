
const connectDB = require('../config/database');
const User = require('../models/User');
require('dotenv').config(); // Load .env from current directory

const usersToCreate = [
    { name: 'Admin', phone: '9999999998', password: 'Admin@123', role: 'admin' },
    { name: 'Teacher A', phone: '9999999997', password: 'Teacher@123', role: 'teacher' },
    { name: 'Teacher B', phone: '9999999996', password: 'Teacher@123', role: 'teacher' },
    { name: 'Teacher C', phone: '9999999995', password: 'Teacher@123', role: 'teacher' },
    { name: 'Teacher D', phone: '9999999994', password: 'Teacher@123', role: 'teacher' },
    { name: 'Teacher E', phone: '9999999993', password: 'Teacher@123', role: 'teacher' },
    { name: 'Student F', phone: '9999999987', password: 'Student@123', role: 'student' },
    { name: 'Student G', phone: '9999999986', password: 'Student@123', role: 'student' },
    { name: 'Student H', phone: '9999999985', password: 'Student@123', role: 'student' },
    { name: 'Student I', phone: '9999999984', password: 'Student@123', role: 'student' },
    { name: 'Student J', phone: '9999999983', password: 'Student@123', role: 'student' },
    { name: 'Student K', phone: '9999999982', password: 'Student@123', role: 'student' },
    { name: 'Student L', phone: '9999999981', password: 'Student@123', role: 'student' },
    { name: 'Student M', phone: '9999999980', password: 'Student@123', role: 'student' },
    { name: 'Student N', phone: '9999999979', password: 'Student@123', role: 'student' },
    { name: 'Student O', phone: '9999999978', password: 'Student@123', role: 'student' },
    { name: 'Student P', phone: '9999999977', password: 'Student@123', role: 'student' },
    { name: 'Student Q', phone: '9999999976', password: 'Student@123', role: 'student' },
    { name: 'Student R', phone: '9999999975', password: 'Student@123', role: 'student' },
    { name: 'Student S', phone: '9999999974', password: 'Student@123', role: 'student' },
    { name: 'Student T', phone: '9999999973', password: 'Student@123', role: 'student' },
    { name: 'Student U', phone: '9999999972', password: 'Student@123', role: 'student' },
    { name: 'Student V', phone: '9999999971', password: 'Student@123', role: 'student' },
    { name: 'Student W', phone: '9999999970', password: 'Student@123', role: 'student' },
    { name: 'Student X', phone: '9999999969', password: 'Student@123', role: 'student' },
    { name: 'Student Y', phone: '9999999968', password: 'Student@123', role: 'student' },
    { name: 'Student Z', phone: '9999999967', password: 'Student@123', role: 'student' }
];

const createUsers = async () => {
    try {
        await connectDB();
        console.log('Database connected...');

        for (const userData of usersToCreate) {
            const existingUser = await User.findOne({ phone: userData.phone });
            if (existingUser) {
                console.log(`User ${userData.name} (${userData.phone}) already exists. Skipping.`);
                continue;
            }

            const user = new User(userData);
            await user.save();
            console.log(`User ${userData.name} (${userData.phone}) created successfully.`);
        }

        console.log('Bulk user creation process completed.');
        process.exit(0);
    } catch (error) {
        console.error('Error creating users:', error);
        process.exit(1);
    }
};

createUsers();
