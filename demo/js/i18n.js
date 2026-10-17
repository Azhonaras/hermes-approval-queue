export const TITLES = {
  'update:canonical': 'به‌روزرسانی Canonical',
  'update:onpage': 'به‌روزرسانی SEO درون‌صفحه',
  'update:redirect': 'به‌روزرسانی Redirect',
  'update:schema': 'به‌روزرسانی Schema',
  'update:indexing': 'به‌روزرسانی ایندکس',
  'update:contentlinks': 'به‌روزرسانی لینک‌های داخلی',
  'update:content': 'ویرایش متن نوشته',
  'delete:post': 'حذف نوشته (به زباله‌دان)',
  'delete:taxonomy': 'حذف طبقه‌بندی',
  'create:taxonomy': 'ایجاد طبقه‌بندی',
  'update:taxonomy': 'به‌روزرسانی طبقه‌بندی',
  'merge:taxonomy': 'ادغام طبقه‌بندی'
};

export const STATUS_TEXT = {
  Pending: 'در انتظار',
  Approved: 'تأیید شده — منتظر اجرا',
  Rejected: 'رد شده',
  Consumed: 'اجرا شده',
  ChangesRequested: 'بازگردانده برای اصلاح',
  Expired: 'منقضی'
};

export const titleOf = (action) => TITLES[action] || action;
