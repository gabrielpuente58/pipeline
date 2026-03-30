async function seedApplications(Application) {
  const count = await Application.countDocuments();
  if (count > 0) return;

  const now = Date.now();
  const days = (n) => new Date(now - n * 24 * 60 * 60 * 1000);

  await Application.create({
    company: "Google",
    position: "Software Engineer II",
    status: "interviewing",
    appliedDate: days(14),
    jobUrl: "https://careers.google.com",
    notes: "Applied via LinkedIn. Phone screen scheduled with recruiter.",
    contactName: "Sarah Chen",
    contactEmail: "schen@google.com",
  });

  console.log("Seeded sample applications");
}

module.exports = { seedApplications };
