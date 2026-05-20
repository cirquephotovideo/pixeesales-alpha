// PDF generation pour devis/factures avec branding Pixeeplay
import express from 'express';
import PDFDocument from 'pdfkit';

export function pdfRoutes(db) {
  const r = express.Router();

  r.post('/devis', (req, res) => {
    const d = req.body;
    if (!d || !d.ref) return res.status(400).json({ error: 'Missing devis data' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${d.ref}.pdf"`);
    generateDocPDF(res, d, 'DEVIS');
  });

  r.post('/facture', (req, res) => {
    const f = req.body;
    if (!f || !f.ref) return res.status(400).json({ error: 'Missing facture data' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${f.ref}.pdf"`);
    generateDocPDF(res, f, 'FACTURE');
  });

  return r;
}

function generateDocPDF(stream, doc, type) {
  const branding = doc.branding || {
    company: 'PIXEEPLAY',
    address: 'Pixeeplay · France',
    email: 'contact@pixeeplay.com',
    phone: '+33 6 73 18 82 96',
    color: '#7C3AED'
  };

  const pdf = new PDFDocument({ size: 'A4', margin: 50 });
  pdf.pipe(stream);

  // Header
  pdf.fillColor(branding.color).fontSize(20).text(branding.company, 50, 50);
  pdf.fillColor('#475569').fontSize(9).text(branding.address || '', 50, 75);
  if (branding.email) pdf.text(branding.email, 50, 88);
  if (branding.phone) pdf.text(branding.phone, 50, 101);

  // Doc type + ref
  pdf.fillColor('#0F172A').fontSize(28).text(type, 400, 50);
  pdf.fontSize(11).fillColor('#475569').text(doc.ref || '', 400, 82);
  pdf.text('Émis le ' + new Date(doc.date || Date.now()).toLocaleDateString('fr-FR'), 400, 96);
  if (doc.echeance) pdf.text('Échéance ' + new Date(doc.echeance).toLocaleDateString('fr-FR'), 400, 110);

  // Client
  pdf.moveTo(50, 140).lineTo(545, 140).strokeColor('#E5E7EB').stroke();
  pdf.fontSize(10).fillColor('#94A3B8').text('CLIENT', 50, 155);
  pdf.fontSize(13).fillColor('#0F172A').text(doc.clientLabel || doc.client?.name || 'Client à définir', 50, 170);

  // Lignes
  let y = 230;
  pdf.fontSize(10).fillColor('#94A3B8');
  pdf.text('DESCRIPTION', 50, y);
  pdf.text('MONTANT HT', 450, y, { width: 95, align: 'right' });
  pdf.moveTo(50, y+15).lineTo(545, y+15).strokeColor('#E5E7EB').stroke();
  y += 25;

  pdf.fillColor('#0F172A').fontSize(11);
  for (const item of (doc.items || [])) {
    pdf.text(item.desc || item.description || '', 50, y, { width: 380 });
    const price = item.price || (item.qty && item.unitPrice ? item.qty*item.unitPrice : 0);
    pdf.text((price).toFixed(2).replace('.',',') + ' €', 450, y, { width: 95, align: 'right' });
    y += 22;
  }

  // Totaux
  y += 20;
  pdf.moveTo(300, y).lineTo(545, y).strokeColor('#E5E7EB').stroke(); y += 10;
  pdf.fontSize(10).fillColor('#475569');
  pdf.text('Total HT', 300, y); pdf.text((doc.totalHT||0).toFixed(2).replace('.',',') + ' €', 450, y, { width: 95, align: 'right' }); y += 18;
  pdf.text(`TVA ${doc.tva||20}%`, 300, y); pdf.text(((doc.totalTTC||0)-(doc.totalHT||0)).toFixed(2).replace('.',',') + ' €', 450, y, { width: 95, align: 'right' }); y += 18;
  pdf.fontSize(13).fillColor(branding.color);
  pdf.text('Total TTC', 300, y); pdf.text((doc.totalTTC||0).toFixed(2).replace('.',',') + ' €', 450, y, { width: 95, align: 'right' });

  // Mentions légales
  pdf.fontSize(8).fillColor('#94A3B8');
  pdf.text(
    [
      type === 'DEVIS' ? `Devis valable ${doc.validite||30} jours à compter de la date d'émission. À retourner signé avec la mention "Bon pour accord".` : 'Paiement à réception. En cas de retard, pénalités au taux légal en vigueur.',
      branding.tva ? 'N° TVA Intracom : ' + branding.tva : '',
      branding.iban ? 'IBAN : ' + branding.iban : '',
      branding.siret ? 'SIRET : ' + branding.siret : ''
    ].filter(Boolean).join('\n'),
    50, 720, { width: 495 }
  );

  pdf.end();
}
