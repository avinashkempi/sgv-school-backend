const {
  normalizeClassKey,
  getClassExamWeights,
  computeClassWeightedMarks
} = require('../../src/utils/examWeightResolver');
const {
  getISTDateString,
  getISTMonthYear,
  getPreviousMonthYear,
  isISTSunday,
  getISTDayBounds,
  validateAttendanceDate
} = require('../../src/utils/dateUtils');
const toTitleCase = require('../../src/utils/titleCase');
const Event = require('../../src/models/Event');
const mongoose = require('mongoose');

describe('Backend Core Utilities', () => {
  describe('toTitleCase', () => {
    it('converts ALL CAPS and lowercase to title case', () => {
      expect(toTitleCase('JOHN DOE')).toBe('John Doe');
      expect(toTitleCase('aman kumar')).toBe('Aman Kumar');
    });

    it('preserves small connector words unless at start', () => {
      expect(toTitleCase('city of angels')).toBe('City of Angels');
      expect(toTitleCase('of mice and men')).toBe('Of Mice and Men');
    });

    it('handles falsy or empty inputs gracefully', () => {
      expect(toTitleCase('')).toBe('');
      expect(toTitleCase(null)).toBe('');
      expect(toTitleCase(undefined)).toBe('');
    });
  });

  describe('examWeightResolver', () => {
    describe('normalizeClassKey', () => {
      it('correctly extracts Arabic grade numerals', () => {
        expect(normalizeClassKey('10th Standard')).toBe('10');
        expect(normalizeClassKey('Class 5')).toBe('5');
        expect(normalizeClassKey('1st Standard')).toBe('1');
        expect(normalizeClassKey('Grade 12')).toBe('12');
      });

      it('normalizes pre-primary grades', () => {
        expect(normalizeClassKey('LKG_U')).toBe('lkg');
        expect(normalizeClassKey('Playhome (Ugar)')).toBe('playhome');
        expect(normalizeClassKey('UKG (Mangasuli)')).toBe('ukg');
        expect(normalizeClassKey('Nursery')).toBe('playhome');
      });

      it('rejects raw 24-character hex ObjectIds', () => {
        expect(normalizeClassKey('65a1234567890abcdef12345')).toBeNull();
      });

      it('handles null and undefined', () => {
        expect(normalizeClassKey(null)).toBeNull();
        expect(normalizeClassKey(undefined)).toBeNull();
      });
    });

    describe('getClassExamWeights', () => {
      it('returns explicit database weights if provided on the class object', () => {
        const customWeights = { FA1: 10, FA2: 10, SA1: 30, FA3: 10, FA4: 10, SA2: 30 };
        const result = getClassExamWeights({ examWeights: customWeights });
        expect(result).toEqual(customWeights);
      });

      it('falls back to default weights when null or unrecognized is provided', () => {
        const result = getClassExamWeights(null);
        expect(result).toHaveProperty('FA1');
        expect(result).toHaveProperty('SA1');
      });
    });

    describe('computeClassWeightedMarks', () => {
      it('computes accurate weighted percentage', () => {
        const scores = { FA1: 80, SA1: 90 };
        const weights = { FA1: 20, SA1: 80 };
        // (80*20 + 90*80) / 100 = (1600 + 7200) / 100 = 88.0
        const result = computeClassWeightedMarks(scores, weights);
        expect(result).toBe(88.0);
      });

      it('returns null for empty or invalid scores', () => {
        expect(computeClassWeightedMarks({}, { FA1: 20 })).toBeNull();
        expect(computeClassWeightedMarks(null, { FA1: 20 })).toBeNull();
      });

      it('falls back to simple average if total completed weight is zero', () => {
        const scores = { FA1: 70, FA2: 90 };
        const weights = { FA1: 0, FA2: 0 };
        expect(computeClassWeightedMarks(scores, weights)).toBe(80.0);
      });
    });
  });

  describe('dateUtils', () => {
    describe('getISTDateString', () => {
      it('converts Date object to YYYY-MM-DD in Asia/Kolkata', () => {
        // 2026-08-15 00:00:00 IST is 2026-08-14 18:30:00 UTC
        const utcDate = new Date('2026-08-14T18:30:00.000Z');
        expect(getISTDateString(utcDate)).toBe('2026-08-15');
      });

      it('preserves clean YYYY-MM-DD string inputs', () => {
        expect(getISTDateString('2026-11-03')).toBe('2026-11-03');
      });

      it('returns empty string for invalid dates', () => {
        expect(getISTDateString('invalid-date')).toBe('');
      });
    });

    describe('getISTMonthYear', () => {
      it('extracts year and 1-based month', () => {
        const result = getISTMonthYear('2026-11-03');
        expect(result).toEqual({ year: 2026, month: 11 });
      });
    });

    describe('getPreviousMonthYear', () => {
      it('extracts previous month and year for normal months', () => {
        const result = getPreviousMonthYear('2026-11-03');
        expect(result).toEqual({ year: 2026, month: 10 });
      });

      it('wraps to previous year and December when given January', () => {
        const result = getPreviousMonthYear('2026-01-15');
        expect(result).toEqual({ year: 2025, month: 12 });
      });
    });

    describe('isISTSunday', () => {
      it('identifies Sundays in IST correctly', () => {
        // 2026-11-01 is Sunday
        expect(isISTSunday('2026-11-01')).toBe(true);
        // 2026-11-02 is Monday
        expect(isISTSunday('2026-11-02')).toBe(false);
      });
    });

    describe('getISTDayBounds', () => {
      it('calculates proper startOfDay and endOfDay in IST', () => {
        const bounds = getISTDayBounds('2026-11-03');
        expect(bounds.dateStr).toBe('2026-11-03');
        expect(bounds.startOfDay.toISOString()).toBe('2026-11-02T18:30:00.000Z');
        expect(bounds.endOfDay.toISOString()).toBe('2026-11-03T18:29:59.999Z');
      });
    });

    describe('validateAttendanceDate', () => {
      it('disallows attendance on Sundays', async () => {
        const result = await validateAttendanceDate('2026-11-01');
        expect(result.allowed).toBe(false);
        expect(result.reason).toMatch(/Sundays/);
      });

      it('disallows attendance on declared school holidays', async () => {
        // Create an event that is a holiday
        await Event.create({
          title: 'Diwali Holiday',
          date: new Date('2026-11-04T10:00:00+05:30'),
          isHoliday: true,
          createdBy: new mongoose.Types.ObjectId()
        });

        const result = await validateAttendanceDate('2026-11-04');
        expect(result.allowed).toBe(false);
        expect(result.reason).toContain('Diwali Holiday');
      });

      it('allows attendance on regular working weekdays', async () => {
        // 2026-11-03 is Tuesday and no holiday
        const result = await validateAttendanceDate('2026-11-03');
        expect(result.allowed).toBe(true);
        expect(result.dateStr).toBe('2026-11-03');
      });
    });
  });
});
