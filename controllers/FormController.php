<?php
// controllers/FormController.php
header('Access-Control-Allow-Origin: *');
// Autoriser les méthodes HTTP spécifiques
header('Access-Control-Allow-Methods: POST, OPTIONS');
// Autoriser les en-têtes spécifiques
header('Access-Control-Allow-Headers: Content-Type');
require_once 'config/database.php'; // Assurez-vous que le chemin est correct

class FormController
{
    private $pdo;

    public function __construct($pdo)
    {
        $this->pdo = $pdo;
    }

    public function handleRequest()
    {
        header("Access-Control-Allow-Origin: *");
        header("Access-Control-Allow-Headers: Content-Type");
        header("Access-Control-Allow-Methods: POST, OPTIONS");

        if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
            http_response_code(200);
            exit();
        }

        // Récupérer et traiter les données du formulaire
        $data = json_decode(file_get_contents("php://input"), true);

        // Validation
        if (empty($data['email'])) {
            $this->sendResponse(400, ['success' => false, 'message' => 'L\'email est requis.']);
            return;
        }

        $email = filter_var(trim($data['email']), FILTER_SANITIZE_EMAIL);

        if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
            $this->sendResponse(400, ['success' => false, 'message' => 'Email invalide.']);
            return;
        }

        // Essayer d'insérer l'email dans la base de données
        $this->saveEmail($email);
    }

    private function saveEmail($email)
    {
        try {
            $stmt = $this->pdo->prepare('INSERT INTO emails (email) VALUES (:email)');
            $stmt->bindParam(':email', $email);

            if ($stmt->execute()) {
                $this->sendResponse(200, ['success' => true, 'message' => 'Votre email a bien été enregistré.']);
            } else {
                $this->sendResponse(500, ['success' => false, 'message' => 'Erreur lors de l\'enregistrement de l\'email.']);
            }
        } catch (PDOException $e) {
            $this->sendResponse(500, ['success' => false, 'message' => 'Cette adresse email est déjà dans notre base de données']);
        }
    }

    private function sendResponse($statusCode, $response)
    {
        http_response_code($statusCode);
        echo json_encode($response);
        exit();
    }
}
