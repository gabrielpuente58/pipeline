const defaultItems = [
  // Swim
  { category: "swim", name: "Wetsuit", weeksBeforeNeeded: 4, isDefault: true },
  { category: "swim", name: "Swim goggles", weeksBeforeNeeded: 2, isDefault: true },
  { category: "swim", name: "Swim cap (race-provided)", weeksBeforeNeeded: 0, isDefault: true },
  { category: "swim", name: "Anti-chafe Body Glide", weeksBeforeNeeded: 1, isDefault: true },
  { category: "swim", name: "Earplugs", weeksBeforeNeeded: 1, isDefault: true },

  // Bike
  { category: "bike", name: "Road/triathlon bike", weeksBeforeNeeded: 8, isDefault: true },
  { category: "bike", name: "Bike helmet (USAT approved)", weeksBeforeNeeded: 4, isDefault: true },
  { category: "bike", name: "Cycling shoes + cleats", weeksBeforeNeeded: 4, isDefault: true },
  { category: "bike", name: "Bike computer / GPS", weeksBeforeNeeded: 2, isDefault: true },
  { category: "bike", name: "CO2 cartridges + inflator", weeksBeforeNeeded: 2, isDefault: true },
  { category: "bike", name: "Spare inner tube", weeksBeforeNeeded: 2, isDefault: true },
  { category: "bike", name: "Tire levers", weeksBeforeNeeded: 2, isDefault: true },
  { category: "bike", name: "Bike saddle bag", weeksBeforeNeeded: 2, isDefault: true },
  { category: "bike", name: "Sunglasses", weeksBeforeNeeded: 1, isDefault: true },
  { category: "bike", name: "Bike service / tune-up", weeksBeforeNeeded: 3, isDefault: true },

  // Run
  { category: "run", name: "Running shoes", weeksBeforeNeeded: 4, isDefault: true },
  { category: "run", name: "Race belt / bib holder", weeksBeforeNeeded: 1, isDefault: true },
  { category: "run", name: "Running socks", weeksBeforeNeeded: 1, isDefault: true },
  { category: "run", name: "Running hat / visor", weeksBeforeNeeded: 1, isDefault: true },
  { category: "run", name: "GPS watch", weeksBeforeNeeded: 2, isDefault: true },

  // T1 (Swim -> Bike)
  { category: "t1", name: "T1 bag packed", weeksBeforeNeeded: 0, isDefault: true },
  { category: "t1", name: "Towel (to dry off)", weeksBeforeNeeded: 0, isDefault: true },
  { category: "t1", name: "Bike gloves", weeksBeforeNeeded: 1, isDefault: true },
  { category: "t1", name: "Sunscreen applied", weeksBeforeNeeded: 0, isDefault: true },

  // T2 (Bike -> Run)
  { category: "t2", name: "T2 bag packed", weeksBeforeNeeded: 0, isDefault: true },
  { category: "t2", name: "Running shoes staged", weeksBeforeNeeded: 0, isDefault: true },
  { category: "t2", name: "Race belt staged", weeksBeforeNeeded: 0, isDefault: true },

  // Nutrition
  { category: "nutrition", name: "Energy gels (race day)", weeksBeforeNeeded: 1, isDefault: true },
  { category: "nutrition", name: "Electrolyte tablets", weeksBeforeNeeded: 1, isDefault: true },
  { category: "nutrition", name: "Water bottles for bike", weeksBeforeNeeded: 1, isDefault: true },
  { category: "nutrition", name: "Pre-race breakfast planned", weeksBeforeNeeded: 0, isDefault: true },
  { category: "nutrition", name: "Carb loading meals (3 days out)", weeksBeforeNeeded: 0, isDefault: true },
];

async function seedChecklist(ChecklistItem) {
  const count = await ChecklistItem.countDocuments({ isDefault: true });
  if (count === 0) {
    await ChecklistItem.insertMany(defaultItems);
    console.log("Seeded default checklist items");
  }
}

module.exports = { seedChecklist };
