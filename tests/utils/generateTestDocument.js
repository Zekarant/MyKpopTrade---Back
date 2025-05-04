const { createCanvas } = require('canvas');
const fs = require('fs');
const path = require('path');

function generateMockIDCard() {
  // Créer un canvas pour dessiner l'image
  const canvas = createCanvas(800, 500);
  const ctx = canvas.getContext('2d');

  // Fond bleu clair
  ctx.fillStyle = '#e0f0ff';
  ctx.fillRect(0, 0, 800, 500);

  // Barre supérieure
  ctx.fillStyle = '#2060a0';
  ctx.fillRect(0, 0, 800, 80);
  
  // Rectangle pour la photo
  ctx.fillStyle = '#f0f0f0';
  ctx.fillRect(40, 120, 180, 220);
  
  // Texte en blanc sur la barre
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 30px Arial';
  ctx.fillText('CARTE NATIONALE D\'IDENTITÉ', 220, 50);
  
  // Informations personnelles
  ctx.fillStyle = '#000000';
  ctx.font = 'bold 16px Arial';
  
  // Nom et prénom
  ctx.fillText('Nom / Name:', 260, 140);
  ctx.fillText('DOE', 400, 140);
  
  ctx.fillText('Prénom / First name:', 260, 180);
  ctx.fillText('JOHN', 400, 180);
  
  ctx.fillText('Né(e) le / Date of birth:', 260, 220);
  ctx.fillText('01.01.1990', 400, 220);
  
  ctx.fillText('Adresse / Address:', 260, 260);
  ctx.fillText('123 RUE DE TEST', 400, 260);
  ctx.fillText('75000 PARIS', 400, 280);
  
  // Numéro de la carte
  ctx.fillText('N° de carte / Card number:', 260, 320);
  ctx.fillText('123ABC456DEF', 400, 320);
  
  // Zone MRZ (bas de la carte)
  ctx.fillStyle = '#f0f0f0';
  ctx.fillRect(40, 400, 720, 60);
  ctx.fillStyle = '#000000';
  ctx.font = 'monospace 16px Courier';
  ctx.fillText('IDFRA123456<<<<<<<<<<<<<<<', 60, 430);
  ctx.fillText('9001014M2401015FRA<<<<<<<<', 60, 450);
  ctx.fillText('DOE<<JOHN<<<<<<<<<<<<<<<<', 60, 470);

  // Exporter l'image
  const buffer = canvas.toBuffer('image/jpeg');
  const testFilePath = path.join(__dirname, 'mock_id_card.jpg');
  fs.writeFileSync(testFilePath, buffer);
  
  console.log(`Document de test créé: ${testFilePath}`);
  return testFilePath;
}

// Exécuter si lancé directement
if (require.main === module) {
  generateMockIDCard();
}

module.exports = { generateMockIDCard };