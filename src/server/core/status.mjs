export const STATUS = Object.freeze({
  Pending: 'Pending',
  Approved: 'Approved',
  Rejected: 'Rejected',
  ChangesRequested: 'ChangesRequested',
  Consumed: 'Consumed',
  Expired: 'Expired'
});

export const LIFECYCLE = Object.freeze(Object.values(STATUS));

/** Rows shown on the History tab. Approved stays visible until it is consumed. */
export const HISTORY = Object.freeze([
  STATUS.Approved, STATUS.Rejected, STATUS.Consumed, STATUS.ChangesRequested, STATUS.Expired
]);

/** Rows the clock can expire. */
export const EXPIRABLE = Object.freeze([STATUS.Pending, STATUS.Approved]);

export const DECISIONS = Object.freeze({
  approve: STATUS.Approved,
  reject: STATUS.Rejected,
  'request-changes': STATUS.ChangesRequested
});
