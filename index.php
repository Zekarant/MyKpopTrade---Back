<?php
header('Access-Control-Allow-Origin: *'); // Permettre toutes les origines, à modifier en production pour des raisons de sécurité
header('Access-Control-Allow-Methods: POST, OPTIONS'); // Méthodes autorisées
header('Access-Control-Allow-Headers: Content-Type'); // En-têtes autorisés

// Si la méthode de la requête est OPTIONS, répondez simplement avec un code 200
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit();
}

// Chargement des dépendances et fichiers nécessaires
$pdo = require_once 'config/database.php';
require_once 'controllers/FormController.php';

// Vérifie si la requête est un POST
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    // Redirige la requête vers le contrôleur
    $controller = new FormController($pdo);
    $controller->handleRequest();
} else {
    // Si la requête n'est pas un POST, renvoyer une page d'erreur ou une vue
    http_response_code(405);
    echo json_encode(['success' => false, 'message' => 'Méthode non autorisée.']);
}
