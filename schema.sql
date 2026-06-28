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
    role ENUM('admin', 'curator', 'student') NOT NULL DEFAULT 'student',
    birth_date DATE,
    group_name VARCHAR(100),
    email VARCHAR(150),
    phone VARCHAR(20),
    token_version INT NOT NULL DEFAULT 0,
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
    school VARCHAR(255) COMMENT 'Школа, которую окончил',
    home_address VARCHAR(500) COMMENT 'Домашний адрес',
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
    methodology_data JSON COMMENT 'Снимок формулы методики на момент создания теста',
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
    assignment_id INT NULL,
    answers JSON NOT NULL,
    score DECIMAL(10,2),
    status ENUM('in_progress', 'completed') DEFAULT 'in_progress',
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (questionnaire_id) REFERENCES questionnaires(id) ON DELETE CASCADE
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

ALTER TABLE results
    ADD CONSTRAINT fk_results_assignment
    FOREIGN KEY (assignment_id) REFERENCES assignments(id) ON DELETE CASCADE;

-- Пользовательские методики (создаются психологом через редактор).
-- Всё определение методики (вопросы, шкалы, интерпретация) хранится в JSON `data`.
CREATE TABLE methodologies (
    id INT AUTO_INCREMENT PRIMARY KEY,
    meth_key VARCHAR(100) UNIQUE,
    title VARCHAR(255) NOT NULL,
    data JSON NOT NULL,
    created_by INT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
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

-- Кампании анонимных анкет. Они намеренно не связаны со студентами.
CREATE TABLE anonymous_campaigns (
    id INT AUTO_INCREMENT PRIMARY KEY,
    survey_key VARCHAR(80) NOT NULL,
    title VARCHAR(255) NOT NULL,
    survey_data JSON NOT NULL COMMENT 'Снимок вопросов и вариантов на момент запуска',
    target_group VARCHAR(100),
    access_token CHAR(64) UNIQUE NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    closes_at DATETIME NULL,
    created_by INT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_anonymous_campaigns_active (is_active, closes_at)
);

-- Обезличенные ответы: без user_id, ФИО, логина и IP-адреса.
CREATE TABLE anonymous_responses (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    campaign_id INT NOT NULL,
    answers JSON NOT NULL,
    submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (campaign_id) REFERENCES anonymous_campaigns(id) ON DELETE CASCADE,
    INDEX idx_anonymous_responses_campaign (campaign_id, submitted_at)
);

-- Индексы для оптимизации
CREATE INDEX idx_users_role ON users(role);
CREATE INDEX idx_users_group ON users(group_name);
CREATE INDEX idx_results_user ON results(user_id);
CREATE INDEX idx_results_questionnaire ON results(questionnaire_id);
CREATE UNIQUE INDEX uq_results_assignment ON results(assignment_id);
CREATE INDEX idx_assignments_user ON assignments(user_id, status);

-- ============================================
-- БЕЗОПАСНАЯ ПЕРВИЧНАЯ НАСТРОЙКА
-- ============================================
-- Пароли намеренно не хранятся в этом файле.
-- 1. Создайте пользователя MySQL с уникальным сильным паролем.
-- 2. Выдайте ему права на psych_diagnostic, psych_control и создание БД колледжей.
-- 3. Запишите значения в .env по образцу .env.example.
-- 4. Создайте первого администратора командой npm run create-admin.
