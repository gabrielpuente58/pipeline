const mongoose = require("mongoose");

const contactSchema = new mongoose.Schema(
  {
    name: { type: String, required: [true, "Name is required"], trim: true },
    email: { type: String, required: [true, "Email is required"], trim: true },
    company: { type: String, required: [true, "Company is required"], trim: true },
    role: { type: String, trim: true },
    linkedinUrl: { type: String, trim: true },
    notes: { type: String },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Contact", contactSchema);
