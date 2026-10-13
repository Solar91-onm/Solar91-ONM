from app.main import app


def test_app_waits_for_deploy_setup_before_serving(client, monkeypatch):
    monkeypatch.setattr("app.main.settings.app_env", "production")
    original_ready = app.state.bootstrap_ready
    app.state.bootstrap_ready = False
    try:
        assert client.get("/").status_code == 503
        response = client.get("/health/ready")
        assert response.status_code == 503
        assert response.json() == {"status": "initializing"}

        app.state.bootstrap_ready = True
        assert client.get("/health/ready").status_code == 200
    finally:
        app.state.bootstrap_ready = original_ready
