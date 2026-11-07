"use strict";
const toggle = document.getElementById("details-toggle");
const details = document.getElementById("details");
if (toggle && details) {
  toggle.addEventListener("click", () => {
    const expanded = toggle.getAttribute("aria-expanded") === "true";
    toggle.setAttribute("aria-expanded", String(!expanded));
    details.hidden = expanded;
    toggle.firstChild.textContent = expanded ? "Show the integrity model " : "Hide the integrity model ";
    const symbol = toggle.querySelector("span");
    if (symbol) symbol.textContent = expanded ? "+" : "−";
  });
}
