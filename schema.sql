-- ============================================
-- БАЗА ДАННЫХ ПСИХОЛОГИЧЕСКОЙ ДИАГНОСТИКИ
-- ============================================

CREATE DATABASE IF NOT EXISTS psych_diagnostic
CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

USE psych_diagnostic;

-- Таблица пользователей
CREATE TABLE users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(100) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    full_name VARCHAR(255) NOT NULL,
    role ENUM('admin', 'student') NOT NULL DEFAULT 'student',
    birth_date DATE,
    group_name VARCHAR(100),
    course INT,
    specialty VARCHAR(200),
    email VARCHAR(150),
    phone VARCHAR(20),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    is_active BOOLEAN DEFAULT TRUE
);

-- Профиль студента (семейные данные)
CREATE TABLE student_profiles (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT UNIQUE NOT NULL,
    family_type ENUM('full', 'single_parent', 'guardian', 'other') NOT NULL,
    lives_with TEXT COMMENT 'С кем проживает студент',
    brothers_count INT DEFAULT 0,
    sisters_count INT DEFAULT 0,
    psychologist_notes TEXT COMMENT 'Примечания педагога-психолога',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Таблица опросников/тестов
CREATE TABLE questionnaires (
    id INT AUTO_INCREMENT PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    created_by INT NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    target_groups JSON COMMENT 'Группы, которым назначен',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id)
);

-- Вопросы опросника
CREATE TABLE questions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    questionnaire_id INT NOT NULL,
    question_text TEXT NOT NULL,
    question_type ENUM('single', 'multiple', 'scale', 'text') NOT NULL,
    options JSON COMMENT 'Варианты ответов для выбора',
    scale_min INT DEFAULT 1,
    scale_max INT DEFAULT 5,
    scale_labels JSON COMMENT 'Подписи шкалы',
    is_required BOOLEAN DEFAULT TRUE,
    order_index INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (questionnaire_id) REFERENCES questionnaires(id) ON DELETE CASCADE
);

-- Результаты диагностики
CREATE TABLE results (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    questionnaire_id INT NOT NULL,
    answers JSON NOT NULL,
    score DECIMAL(10,2),
    status ENUM('in_progress', 'completed') DEFAULT 'in_progress',
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (questionnaire_id) REFERENCES questionnaires(id) ON DELETE CASCADE
);

-- Согласие родителей
CREATE TABLE parental_consents (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT UNIQUE NOT NULL,
    parent_full_name VARCHAR(255) NOT NULL,
    parent_relationship ENUM('mother', 'father', 'guardian', 'other') NOT NULL,
    parent_phone VARCHAR(20),
    parent_email VARCHAR(150),
    consent_text LONGTEXT NOT NULL,
    consent_date DATE,
    signature_status ENUM('pending', 'confirmed', 'rejected') DEFAULT 'pending',
    signature_image_path VARCHAR(500) COMMENT 'Путь к скану подписи',
    notes TEXT,
    created_by INT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id)
);

-- Назначения тестов студентам
CREATE TABLE assignments (
    id INT AUTO_INCREMENT PRIMARY KEY,
    questionnaire_id INT NOT NULL,
    user_id INT NOT NULL,
    assigned_by INT NOT NULL,
    due_date DATE,
    status ENUM('assigned', 'started', 'completed', 'expired') DEFAULT 'assigned',
    assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (questionnaire_id) REFERENCES questionnaires(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (assigned_by) REFERENCES users(id)
);

-- Журнал действий (для аудита)
CREATE TABLE audit_log (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT,
    action VARCHAR(100) NOT NULL,
    entity_type VARCHAR(50),
    entity_id INT,
    details JSON,
    ip_address VARCHAR(45),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

-- Индексы для оптимизации
CREATE INDEX idx_users_role ON users(role);
CREATE INDEX idx_users_group ON users(group_name, course);
CREATE INDEX idx_results_user ON results(user_id);
CREATE INDEX idx_results_questionnaire ON results(questionnaire_id);
CREATE INDEX idx_assignments_user ON assignments(user_id, status);
CREATE INDEX idx_consents_user ON parental_consents(user_id, signature_status);

-- Вставка администратора по умолчанию
INSERT INTO users (username, password, full_name, role, email) 
VALUES ('admin', '$2b$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', 
        'Администратор Психолог', 'admin', 'admin@college.ru');