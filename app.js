//   URL,     Google Apps Script
const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbyI03YLzjM6RGVYRIGcU2G4BGWTnaWwVlgG3SwG_hPAAgE92K3egA_Ht7UptSaYYeqhKA/exec";

async function submitData() {
  const amount = document.getElementById("amount").value;
  const category = document.getElementById("category").value;
  const statusDiv = document.getElementById("status");

  if (!amount || amount <= 0) {
    statusDiv.style.color = "red";
    statusDiv.innerText = " !Введіть суму!";
    return;
  }

  statusDiv.style.color = "#666";
  statusDiv.innerText = "Збереження...";

  try {
    //     text/plain,     CORS
    await fetch(SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ amount, category })
    });

    statusDiv.style.color = "green";
    statusDiv.innerText = "Збережено";
    document.getElementById("amount").value = "";
  } catch (err) {
    statusDiv.style.color = "red";
    statusDiv.innerText = err;
    console.error(err);
  }
}
