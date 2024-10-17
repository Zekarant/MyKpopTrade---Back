<?php
// config/database.php

$host = 'localhost';
$db = 'mykpoptrade'; // Assurez-vous que le nom de la base de données est correct
$user = 'root'; // Votre nom d'utilisateur
$pass = ''; // Votre mot de passe

try {
    $pdo = new PDO("mysql:host=$host;dbname=$db;charset=utf8", $user, $pass, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION
    ]);
} catch (PDOException $e) {
    die("Erreur de connexion : " . $e->getMessage());
}

// Retourner l'instance de PDO
return $pdo;
