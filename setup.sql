--PRAGMA foreign_keys = OFF;

-- Drop existing tables (use with caution in production)
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS matches;
DROP TABLE IF EXISTS players;
DROP TABLE IF EXISTS games;
DROP TABLE IF EXISTS tournaments;
DROP TABLE IF EXISTS tournament_players
DROP TABLE IF EXISTS players_games_tournaments;
DROP TABLE IF EXISTS bets;

-- Create the 'users' table
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL
);

-- Create the 'matches' table
CREATE TABLE IF NOT EXISTS matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tournament_id INTEGER NOT NULL,
    game_id INTEGER NOT NULL,
    player1_id INTEGER NOT NULL,
    player2_id INTEGER NOT NULL,
    winner_id INTEGER NOT NULL,
    loser_id INTEGER NOT NULL,
    player1RoundsWon INTEGER NOT NULL,
    player2RoundsWon INTEGER NOT NULL,
    FOREIGN KEY (tournament_id) REFERENCES tournaments(id) ON DELETE CASCADE,
    FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
    FOREIGN KEY (player1_id) REFERENCES players(id) ON DELETE CASCADE,
    FOREIGN KEY (player2_id) REFERENCES players(id) ON DELETE CASCADE,
    FOREIGN KEY (winner_id) REFERENCES players(id) ON DELETE CASCADE,
    FOREIGN KEY (loser_id) REFERENCES players(id) ON DELETE CASCADE
);

-- Create the 'players' table
CREATE TABLE IF NOT EXISTS players (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    country TEXT NOT NULL
);

-- Create the 'games' table
CREATE TABLE IF NOT EXISTS games (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
);


-- Create the 'tournaments' table
CREATE TABLE IF NOT EXISTS tournaments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    date DATE NOT NULL,
    city TEXT NOT NULL,
    country TEXT NOT NULL
);

ALTER TABLE tournaments ADD COLUMN winner_id INTEGER DEFAULT NULL; -- ID of the winning player

CREATE TABLE IF NOT EXISTS players_games_tournaments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tournament_id INTEGER NOT NULL,
    game_id INTEGER NOT NULL,
    player_id INTEGER NOT NULL,
    win_probability REAL DEFAULT 0.0,
    live_odds REAL DEFAULT 1.0,
    is_winner INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (tournament_id) REFERENCES tournaments(id) ON DELETE CASCADE,
    FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
    FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE,
    UNIQUE (tournament_id, game_id, player_id) -- Ensure unique assignment
);

UPDATE players_games_tournaments
SET live_odds = CASE 
  WHEN total_amount > 0 THEN 
    (SELECT SUM(total_amount) 
     FROM players_games_tournaments 
     WHERE tournament_id = players_games_tournaments.tournament_id 
     AND game_id = players_games_tournaments.game_id) 
     / total_amount * 0.95
  ELSE 1.0
END
WHERE tournament_id = ? AND game_id = ?;


-- Create the 'bets' table
CREATE TABLE IF NOT EXISTS bets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    tournament_id INTEGER NOT NULL,
    game_id INTEGER NOT NULL,
    player_id INTEGER NOT NULL,
    amount REAL NOT NULL DEFAULT 0,
    odds REAL NOT NULL DEFAULT 1.0,
    is_winner INTEGER DEFAULT NULL, -- NULL = undecided, 1 = win, 0 = loss
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (tournament_id) REFERENCES tournaments(id) ON DELETE CASCADE,
    FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
    FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE,
    UNIQUE (user_id, tournament_id, game_id, player_id)
);

-- Insert data into the 'users' table
INSERT INTO users (id, username, email, password) VALUES
(1, 'user1', 'user1@example.com', 'password1-hash'), -- Replace 'password1-hash' with a hashed password
(2, 'user2', 'user2@example.com', 'password2-hash'),
(3, 'user3', 'user3@example.com', 'password3-hash'),
(4, 'user4', 'user4@example.com', 'password4-hash'),
(5, 'admin', 'admin@example.com', 'admin-password-hash');

-- Insert data into the 'tournaments' table
INSERT INTO tournaments (id, name, date, city, country) VALUES
(1, 'EVO Japan 2023', '2023-03-31', 'Tokyo', 'Japan'),
(2, 'Combo Breaker 2023', '2023-05-26', 'Schaumburg', 'United States'),
(3, 'CEO 2023', '2023-06-23', 'Daytona Beach', 'United States'),
(4, 'EVO 2023', '2023-08-04', 'Las Vegas', 'United States'),
(5, 'Capcom Pro Tour Finals 2023', '2023-12-15', 'San Francisco', 'United States'),
(6, 'Frosty Faustings XVI', '2024-01-19', 'Chicago', 'United States'),
(7, 'EVO Japan 2024', '2024-03-29', 'Osaka', 'Japan'),
(8, 'Combo Breaker 2024', '2024-05-24', 'Schaumburg', 'United States'),
(9, 'CEO 2024', '2024-06-21', 'Daytona Beach', 'United States'),
(10, 'EVO 2024', '2024-08-02', 'Las Vegas', 'United States'),
(11, 'DreamHack Winter 2024', '2024-11-22', 'Jonkoping', 'Sweden'),
(12, 'Capcom Pro Tour Finals 2024', '2024-12-15', 'San Francisco', 'United States'),
(13, 'EVO Japan 2025', '2025-03-28', 'Tokyo', 'Japan'),
(14, 'Combo Breaker 2025', '2025-05-23', 'Schaumburg', 'United States'),
(15, 'CEO 2025', '2025-06-20', 'Daytona Beach', 'United States'),
(16, 'EVO 2025', '2025-08-01', 'Las Vegas', 'United States'),
(17, 'Red Bull Kumite 2025', '2025-10-05', 'Paris', 'France'),
(18, 'DreamHack Summer 2025', '2025-06-17', 'Jonkoping', 'Sweden'),
(19, 'Frosty Faustings XVII', '2025-01-18', 'Chicago', 'United States'),
(20, 'Capcom Pro Tour Finals 2025', '2025-12-12', 'San Francisco', 'United States'),
(21, 'EVO Japan 2025 Fall', '2025-10-10', 'Osaka', 'Japan'),
(22, 'Red Bull Kumite 2025 London', '2025-11-14', 'London', 'United Kingdom'),
(23, 'DreamHack Fall 2025', '2025-10-27', 'Jonkoping', 'Sweden'),
(24, 'Frosty Faustings XVIII', '2025-02-21', 'Chicago', 'United States');

-- Insert data into the 'games' table
INSERT INTO games (id, name) VALUES
(1, 'Street Fighter 6'),
(2, 'Tekken 8'),
(3, 'Guilty Gear Strive'),
(4, 'Dragon Ball FighterZ'),
(5, 'Mortal Kombat 1'),
(6, 'Super Smash Bros. Ultimate'),
(7, 'King of Fighters XV'),
(8, 'Granblue Fantasy: Versus'),
(9, 'Soulcalibur VI'),
(10, 'Samurai Shodown (2019)'),
(11, 'BlazBlue: Cross Tag Battle'),
(12, 'Melty Blood: Type Lumina'),
(13, 'Street Fighter V'),
(14, 'MultiVersus'),
(15, 'Under Night In-Birth Exe:Late[cl-r]'),
(16, 'Nickelodeon All-Star Brawl'),
(17, 'Virtua Fighter 5: Ultimate Showdown'),
(18, 'Power Rangers: Battle for the Grid');


-- Insert data into the 'players' table
INSERT INTO players (id, name, country) VALUES
(1, 'Tokedo', 'Japan'),
(2, 'Punk', 'United States'),
(3, 'Daigo', 'Japan'),
(4, 'Justin Wong', 'United States'),
(5, 'MenaRD', 'Dominican Republic'),
(6, 'Dual Kevin', 'United States'),
(7, 'Angry Bird', 'United Arab Emirates'),
(8, 'Big Bird', 'United Arab Emirates'),
(9, 'Fujimura', 'Japan'),
(10, 'Gachikun', 'Japan'),
(11, 'SonicFox', 'United States'),
(12, 'NuckleDu', 'United States'),
(13, 'Problem X', 'United Kingdom'),
(14, 'Phenom', 'Norway'),
(15, 'iDom', 'United States'),
(16, 'Luffy', 'France'),
(17, 'Go1', 'Japan'),
(18, 'Leffen', 'Sweden'),
(19, 'Arslan Ash', 'Pakistan'),
(20, 'Knee', 'South Korea');

-- Insert data into the 'matches' table
INSERT INTO matches (id, tournament_id, game_id, player1_id, player2_id, winner_id, loser_id, player1RoundsWon, player2RoundsWon) VALUES
(1, 1, 1, 1, 2, 1, 2, 3, 2),  -- Tokedo defeats Punk at EVO Japan 2023
(2, 1, 3, 2, 4, 3, 4, 4, 2),  -- Daigo defeats Justin Wong at EVO Japan 2023
(3, 2, 5, 1, 6, 5, 6, 3, 1),  -- MenaRD defeats Dual Kevin at Combo Breaker 2023
(4, 2, 7, 2, 8, 8, 7, 2, 3),  -- Big Bird defeats Angry Bird at Combo Breaker 2023
(5, 3, 1, 1, 3, 3, 1, 5, 3),  -- Daigo defeats Tokedo at CEO 2023
(6, 3, 2, 2, 4, 2, 4, 4, 1),  -- Punk defeats Justin Wong at CEO 2023
(7, 4, 7, 1, 6, 7, 6, 4, 2),  -- Angry Bird defeats Dual Kevin at EVO 2023
(8, 4, 5, 2, 8, 8, 5, 3, 2),  -- Big Bird defeats MenaRD at EVO 2023
(9, 5, 1, 1, 4, 4, 1, 5, 4),  -- Justin Wong defeats Tokedo at Capcom Pro Tour Finals 2023
(10, 5, 3, 2, 2, 2, 3, 4, 3), -- Punk defeats Daigo at Capcom Pro Tour Finals 2023
(11, 6, 7, 1, 5, 5, 7, 3, 1), -- MenaRD defeats Angry Bird at Frosty Faustings XVI
(12, 6, 6, 2, 8, 6, 8, 4, 3), -- Dual Kevin defeats Big Bird at Frosty Faustings XVI
(13, 7, 1, 1, 3, 1, 3, 4, 2), -- Tokedo defeats Daigo at EVO Japan 2024
(14, 7, 2, 2, 4, 4, 2, 5, 4), -- Justin Wong defeats Punk at EVO Japan 2024
(15, 8, 6, 1, 5, 6, 5, 3, 1), -- Dual Kevin defeats MenaRD at Combo Breaker 2024
(16, 8, 8, 2, 7, 7, 8, 4, 3), -- Angry Bird defeats Big Bird at Combo Breaker 2024
(17, 9, 3, 1, 4, 3, 4, 3, 2), -- Daigo defeats Justin Wong at CEO 2024
(18, 9, 2, 2, 1, 1, 2, 5, 4), -- Tokedo defeats Punk at CEO 2024
(19, 10, 7, 1, 8, 8, 7, 4, 3), -- Big Bird defeats Angry Bird at EVO 2024
(20, 10, 5, 2, 6, 6, 5, 3, 2); -- Dual Kevin defeats MenaRD at EVO 2024


INSERT INTO players_games_tournaments (tournament_id, game_id, player_id) VALUES
-- Tournament 1
(1, 1, 1), (1, 1, 2), (1, 1, 3), (1, 1, 4), 
(1, 2, 5), (1, 2, 6), (1, 2, 7), (1, 2, 8), 
(1, 3, 9), (1, 3, 10), (1, 3, 11), (1, 3, 12), 
(1, 4, 13), (1, 4, 14), (1, 4, 15), (1, 4, 16), 

-- Tournament 2
(2, 1, 2), (2, 1, 3), (2, 1, 5), (2, 1, 6), 
(2, 2, 7), (2, 2, 8), (2, 2, 9), (2, 2, 10), 
(2, 3, 11), (2, 3, 12), (2, 3, 13), (2, 3, 14), 
(2, 4, 15), (2, 4, 16), (2, 4, 17), (2, 4, 18), 

-- Tournament 3
(3, 1, 3), (3, 1, 4), (3, 1, 7), (3, 1, 8), 
(3, 2, 9), (3, 2, 10), (3, 2, 13), (3, 2, 14), 
(3, 3, 15), (3, 3, 16), (3, 3, 1), (3, 3, 2), 
(3, 4, 3), (3, 4, 5), (3, 4, 6), (3, 4, 7), 

-- Tournament 4
(4, 1, 1), (4, 1, 2), (4, 1, 3), (4, 1, 4), 
(4, 2, 5), (4, 2, 6), (4, 2, 7), (4, 2, 8), 
(4, 3, 9), (4, 3, 10), (4, 3, 11), (4, 3, 12), 
(4, 4, 13), (4, 4, 14), (4, 4, 15), (4, 4, 16), 

-- Tournament 5
(5, 1, 1), (5, 1, 5), (5, 1, 9), (5, 1, 13), 
(5, 2, 2), (5, 2, 6), (5, 2, 10), (5, 2, 14), 
(5, 3, 3), (5, 3, 7), (5, 3, 11), (5, 3, 15), 
(5, 4, 4), (5, 4, 8), (5, 4, 12), (5, 4, 16), 

-- Tournament 6
(6, 1, 2), (6, 1, 6), (6, 1, 10), (6, 1, 14), 
(6, 2, 3), (6, 2, 7), (6, 2, 11), (6, 2, 15), 
(6, 3, 4), (6, 3, 8), (6, 3, 12), (6, 3, 16), 
(6, 4, 1), (6, 4, 5), (6, 4, 9), (6, 4, 13), 

-- Tournament 7
(7, 1, 3), (7, 1, 7), (7, 1, 11), (7, 1, 15), 
(7, 2, 4), (7, 2, 8), (7, 2, 12), (7, 2, 16), 
(7, 3, 1), (7, 3, 5), (7, 3, 9), (7, 3, 13), 
(7, 4, 2), (7, 4, 6), (7, 4, 10), (7, 4, 14), 

-- Tournament 8
(8, 1, 4), (8, 1, 8), (8, 1, 12), (8, 1, 16), 
(8, 2, 1), (8, 2, 5), (8, 2, 9), (8, 2, 13), 
(8, 3, 2), (8, 3, 6), (8, 3, 10), (8, 3, 14), 
(8, 4, 3), (8, 4, 7), (8, 4, 11), (8, 4, 15), 

-- Tournament 9
(9, 1, 1), (9, 1, 5), (9, 1, 9), (9, 1, 13), 
(9, 2, 2), (9, 2, 6), (9, 2, 10), (9, 2, 14), 
(9, 3, 3), (9, 3, 7), (9, 3, 11), (9, 3, 15), 
(9, 4, 4), (9, 4, 8), (9, 4, 12), (9, 4, 16), 

-- Tournament 10
(10, 1, 2), (10, 1, 6), (10, 1, 10), (10, 1, 14), 
(10, 2, 3), (10, 2, 7), (10, 2, 11), (10, 2, 15), 
(10, 3, 4), (10, 3, 8), (10, 3, 12), (10, 3, 16), 
(10, 4, 1), (10, 4, 5), (10, 4, 9), (10, 4, 13),

-- Tournament 11
(11, 1, 2), (11, 1, 6), (11, 1, 10), (11, 1, 14), 
(11, 2, 3), (11, 2, 7), (11, 2, 11), (11, 2, 15), 
(11, 3, 4), (11, 3, 8), (11, 3, 12), (11, 3, 16), 
(11, 4, 1), (11, 4, 5), (11, 4, 9), (11, 4, 13),

-- Tournament 12
(12, 1, 2), (12, 1, 6), (12, 1, 10), (12, 1, 14), 
(12, 2, 3), (12, 2, 7), (12, 2, 11), (12, 2, 15), 
(12, 3, 4), (12, 3, 8), (12, 3, 12), (12, 3, 16), 
(12, 4, 1), (12, 4, 5), (12, 4, 9), (12, 4, 13),

-- Tournament 13
(13, 1, 2), (13, 1, 6), (13, 1, 10), (13, 1, 14), 
(13, 2, 3), (13, 2, 7), (13, 2, 11), (13, 2, 15), 
(13, 3, 4), (13, 3, 8), (13, 3, 12), (13, 3, 16), 
(13, 4, 1), (13, 4, 5), (13, 4, 9), (13, 4, 13),

-- Tournament 14
(14, 1, 2), (14, 1, 6), (14, 1, 10), (14, 1, 14), 
(14, 2, 3), (14, 2, 7), (14, 2, 11), (14, 2, 15), 
(14, 3, 4), (14, 3, 8), (14, 3, 12), (14, 3, 16), 
(14, 4, 1), (14, 4, 5), (14, 4, 9), (14, 4, 13),

-- Tournament 15
(15, 1, 2), (15, 1, 6), (15, 1, 10), (15, 1, 14), 
(15, 2, 3), (15, 2, 7), (15, 2, 11), (15, 2, 15), 
(15, 3, 4), (15, 3, 8), (15, 3, 12), (15, 3, 16), 
(15, 4, 1), (15, 4, 5), (15, 4, 9), (15, 4, 13),

-- Tournament 16
(16, 1, 2), (16, 1, 6), (16, 1, 10), (16, 1, 14), 
(16, 2, 3), (16, 2, 7), (16, 2, 11), (16, 2, 15), 
(16, 3, 4), (16, 3, 8), (16, 3, 12), (16, 3, 16), 
(16, 4, 1), (16, 4, 5), (16, 4, 9), (16, 4, 13),

-- Tournament 17
(17, 1, 2), (17, 1, 6), (17, 1, 10), (17, 1, 14), 
(17, 2, 3), (17, 2, 7), (17, 2, 11), (17, 2, 15), 
(17, 3, 4), (17, 3, 8), (17, 3, 12), (17, 3, 16), 
(17, 4, 1), (17, 4, 5), (17, 4, 9), (17, 4, 13),

-- Tournament 18
(18, 1, 2), (18, 1, 6), (18, 1, 10), (18, 1, 14), 
(18, 2, 3), (18, 2, 7), (18, 2, 11), (18, 2, 15), 
(18, 3, 4), (18, 3, 8), (18, 3, 12), (18, 3, 16), 
(18, 4, 1), (18, 4, 5), (18, 4, 9), (18, 4, 13),    

-- Tournament 19
(19, 1, 2), (19, 1, 6), (19, 1, 10), (19, 1, 14), 
(19, 2, 3), (19, 2, 7), (19, 2, 11), (19, 2, 15), 
(19, 3, 4), (19, 3, 8), (19, 3, 12), (19, 3, 16), 
(19, 4, 1), (19, 4, 5), (19, 4, 9), (19, 4, 13),

-- Tournament 20
(20, 1, 2), (20, 1, 6), (20, 1, 10), (20, 1, 14), 
(20, 2, 3), (20, 2, 7), (20, 2, 11), (20, 2, 15), 
(20, 3, 4), (20, 3, 8), (20, 3, 12), (20, 3, 16), 
(20, 4, 1), (20, 4, 5), (20, 4, 9), (20, 4, 13),

-- Tournament 21
(21, 1, 2), (21, 1, 6), (21, 1, 10), (21, 1, 14), 
(21, 2, 3), (21, 2, 7), (21, 2, 11), (21, 2, 15), 
(21, 3, 4), (21, 3, 8), (21, 3, 12), (21, 3, 16), 
(21, 4, 1), (21, 4, 5), (21, 4, 9), (21, 4, 13),

-- Tournament 22
(22, 1, 2), (22, 1, 6), (22, 1, 10), (22, 1, 14), 
(22, 2, 3), (22, 2, 7), (22, 2, 11), (22, 2, 15), 
(22, 3, 4), (22, 3, 8), (22, 3, 12), (22, 3, 16), 
(22, 4, 1), (22, 4, 5), (22, 4, 9), (22, 4, 13),

-- Tournament 23
(23, 1, 2), (23, 1, 6), (23, 1, 10), (23, 1, 14), 
(23, 2, 3), (23, 2, 7), (23, 2, 11), (23, 2, 15), 
(23, 3, 4), (23, 3, 8), (23, 3, 12), (23, 3, 16), 
(23, 4, 1), (23, 4, 5), (23, 4, 9), (23, 4, 13),

-- Tournament 24
(24, 1, 1), (24, 1, 2), (24, 1, 3), (24, 1, 4),
(24, 2, 5), (24, 2, 6), (24, 2, 7), (24, 2, 8),
(24, 3, 9), (24, 3, 10), (24, 3, 11), (24, 3, 12),
(24, 4, 13), (24, 4, 14), (24, 4, 15), (24, 4, 16);

-- Insert data into the 'bets' table
INSERT INTO bets (id, user_id, tournament_id, game_id, player_id, amount) VALUES
-- User 1 Bets
(1, 1, 1, 1, 1, 100), -- User 1 bets 100 on Tokedo in Street Fighter 6 at EVO Japan 2023
(2, 1, 2, 2, 6, 50),  -- User 1 bets 50 on Dual Kevin in Tekken 7 at Combo Breaker 2023

-- User 2 Bets
(3, 2, 1, 1, 2, 75),  -- User 2 bets 75 on Punk in Street Fighter 6 at EVO Japan 2023
(4, 2, 2, 2, 5, 60),  -- User 2 bets 60 on MenaRD in Tekken 7 at Combo Breaker 2023

-- User 3 Bets
(5, 3, 1, 1, 3, 200), -- User 3 bets 200 on Daigo in Street Fighter 6 at EVO Japan 2023
(6, 3, 3, 4, 8, 150), -- User 3 bets 150 on Big Bird in Dragon Ball FighterZ at CEO 2023

-- User 4 Bets
(7, 4, 3, 1, 4, 100), -- User 4 bets 100 on Justin Wong in Street Fighter 6 at CEO 2023
(8, 4, 4, 3, 7, 80);  -- User 4 bets 80 on Angry Bird in Guilty Gear Strive at EVO 2023

UPDATE bets SET odds = 1.5

-- Enable foreign key constraints
--PRAGMA foreign_keys = ON;