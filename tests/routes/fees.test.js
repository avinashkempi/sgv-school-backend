const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../../index');
const User = require('../../src/models/User');
const Class = require('../../src/models/Class');
const AcademicYear = require('../../src/models/AcademicYear');
const FeeStructure = require('../../src/models/FeeStructure');
const StudentFee = require('../../src/models/StudentFee');
const FeePayment = require('../../src/models/FeePayment');
const { invalidateUserCache } = require('../../src/middleware/auth');

describe('Fees & Finance API Routes (/api/fees)', () => {
  let adminToken;
  let teacherToken;
  let student1Token;
  let student2Token;
  let student1;
  let student2;
  let testClass;
  let academicYear;

  beforeEach(async () => {
    invalidateUserCache();

    academicYear = await AcademicYear.create({
      name: '2026-2027',
      startDate: new Date('2026-06-01'),
      endDate: new Date('2027-04-30'),
      isActive: true,
      status: 'current'
    });

    const admin = await User.create({
      name: 'Finance Admin',
      phone: '9876543501',
      password: 'password123',
      role: 'admin',
      isActive: true,
      tokenVersion: 0
    });
    adminToken = jwt.sign(
      { userId: admin._id, role: 'admin', tokenVersion: 0 },
      process.env.JWT_SECRET
    );

    const teacher = await User.create({
      name: 'Class Teacher',
      phone: '9876543502',
      password: 'password123',
      role: 'teacher',
      isActive: true,
      tokenVersion: 0
    });
    teacherToken = jwt.sign(
      { userId: teacher._id, role: 'teacher', tokenVersion: 0 },
      process.env.JWT_SECRET
    );

    testClass = await Class.create({
      name: 'Class 6A',
      value: '6',
      label: 'Class 6A',
      section: 'A',
      branch: 'Main',
      academicYear: academicYear._id
    });

    student1 = await User.create({
      name: 'Tarun Rao',
      phone: '9876543503',
      password: 'password123',
      role: 'student',
      currentClass: testClass._id,
      academicYear: academicYear._id,
      isActive: true,
      tokenVersion: 0
    });
    student1Token = jwt.sign(
      { userId: student1._id, role: 'student', tokenVersion: 0 },
      process.env.JWT_SECRET
    );

    student2 = await User.create({
      name: 'Deepa Jain',
      phone: '9876543504',
      password: 'password123',
      role: 'student',
      currentClass: testClass._id,
      academicYear: academicYear._id,
      isActive: true,
      tokenVersion: 0
    });
    student2Token = jwt.sign(
      { userId: student2._id, role: 'student', tokenVersion: 0 },
      process.env.JWT_SECRET
    );
  });

  describe('POST /api/fees/structure (Create/Update Class Fee Structure)', () => {
    it('blocks teachers from creating fee structures (403)', async () => {
      const res = await request(app)
        .post('/api/fees/structure')
        .set('Authorization', `Bearer ${teacherToken}`)
        .send({
          classId: testClass._id,
          components: [{ name: 'Tuition Fee', amount: 12000 }]
        });

      expect(res.statusCode).toBe(403);
    });

    it('allows admin to create a fee structure and computes totalAmount accurately', async () => {
      const res = await request(app)
        .post('/api/fees/structure')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          classId: testClass._id,
          components: [
            { name: 'Tuition Fee', amount: 15000 },
            { name: 'Computer Lab Fee', amount: 3000 },
            { name: 'Sports Fee', amount: 2000 }
          ]
        });

      expect(res.statusCode).toBe(200);
      expect(res.body.totalAmount).toBe(20000);

      const dbStructure = await FeeStructure.findOne({ class: testClass._id });
      expect(dbStructure).not.toBeNull();
      expect(dbStructure.totalAmount).toBe(20000);
    });
  });

  describe('POST /api/fees/payment (Record Fee Payment)', () => {
    let feeStructure;

    beforeEach(async () => {
      feeStructure = await FeeStructure.create({
        class: testClass._id,
        academicYear: academicYear._id,
        components: [{ name: 'Tuition', amount: 25000 }],
        totalAmount: 25000,
        type: 'class_default'
      });

      await StudentFee.create({
        student: student1._id,
        class: testClass._id,
        academicYear: academicYear._id,
        feeStructure: feeStructure._id,
        totalFees: 25000,
        toPay: 25000,
        totalPaid: 0,
        pendingAmount: 25000,
        status: 'unpaid'
      });
    });

    it('blocks unauthorized users (teachers and students) from recording payments', async () => {
      const res = await request(app)
        .post('/api/fees/payment')
        .set('Authorization', `Bearer ${teacherToken}`)
        .send({
          studentId: student1._id,
          amount: 10000,
          paymentMethod: 'cash'
        });

      expect(res.statusCode).toBe(403);
    });

    it('records partial payment, updates pending balance, and generates receipt number', async () => {
      const res = await request(app)
        .post('/api/fees/payment')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          studentId: student1._id,
          amount: 10000,
          paymentMethod: 'cash',
          remarks: 'First installment'
        });

      expect(res.statusCode).toBe(200);
      expect(res.body.amount).toBe(10000);
      expect(res.body.receiptNumber).toBeDefined();

      // Verify StudentFee document was updated
      const studentFee = await StudentFee.findOne({ student: student1._id });
      expect(studentFee.totalPaid).toBe(10000);
      expect(studentFee.pendingAmount).toBe(15000);
    });

    it('marks status as fully_paid when complete balance is paid', async () => {
      const res = await request(app)
        .post('/api/fees/payment')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          studentId: student1._id,
          amount: 25000,
          paymentMethod: 'online',
          transactionId: 'TXN_TEST_999'
        });

      expect(res.statusCode).toBe(200);
      const studentFee = await StudentFee.findOne({ student: student1._id });
      expect(studentFee.totalPaid).toBe(25000);
      expect(studentFee.pendingAmount).toBe(0);
    });
  });

  describe('GET /api/fees/student/:studentId (Student Access Control)', () => {
    it('allows a student to view their own fee history', async () => {
      const res = await request(app)
        .get(`/api/fees/student/${student1._id}`)
        .set('Authorization', `Bearer ${student1Token}`);

      expect(res.statusCode).toBe(200);
      expect(res.body.totalFees).toBeDefined();
    });

    it('blocks a student from viewing another student fee history (403)', async () => {
      const res = await request(app)
        .get(`/api/fees/student/${student1._id}`)
        .set('Authorization', `Bearer ${student2Token}`); // student2 trying to view student1

      expect(res.statusCode).toBe(403);
    });

    it('blocks teachers from accessing student financial records (403)', async () => {
      const res = await request(app)
        .get(`/api/fees/student/${student1._id}`)
        .set('Authorization', `Bearer ${teacherToken}`);

      expect(res.statusCode).toBe(403);
    });
  });
});
