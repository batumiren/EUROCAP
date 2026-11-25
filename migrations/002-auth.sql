CREATE TABLE eurocap_auth (
  id integer PRIMARY KEY CHECK (id = 1),
  document jsonb NOT NULL
);
