const UserEmail = require('../models/UserEmail'); // Assurez-vous que le chemin et le nom du modèle sont corrects

exports.addEmail = async (req, res) => {
    const { email } = req.body;

    try {
        // Vérifiez si l'email existe déjà
        const existingEmail = await UserEmail.findOne({ email });
        if (existingEmail) {
            return res.status(400).json({ message: 'Email déjà enregistré' });
        }

        const userEmail = new UserEmail({ email });
        await userEmail.save();
        res.status(201).json(userEmail);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Erreur serveur' });
    }
};