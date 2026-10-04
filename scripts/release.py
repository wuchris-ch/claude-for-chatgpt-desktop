"""Switch staged application code, restoring the prior service on failure."""
import pathlib
import shutil


def atomic_write(file, data):
    file = pathlib.Path(file)
    temporary = file.with_name(file.name+'.install-tmp')
    temporary.write_bytes(data)
    temporary.chmod(0o600)
    temporary.replace(file)


def switch_release(app, stage, config_file, agent_file, activate, stop, restart):
    snapshots = {p: p.read_bytes() if p.exists() else None for p in [config_file, agent_file]}
    previous = app.with_name('app-previous')
    if previous.exists():
        shutil.rmtree(previous)
    had_previous = app.exists()
    if had_previous:
        app.rename(previous)
    try:
        stage.rename(app)
        activate()
    except Exception as error:
        try:
            stop()
            if app.exists():
                app.rename(stage)
            if had_previous:
                previous.rename(app)
            for file, data in snapshots.items():
                if data is None:
                    file.unlink(missing_ok=True)
                else:
                    atomic_write(file, data)
            if had_previous:
                restart()
        except Exception as rollback_error:
            raise RuntimeError(f'Installation failed: {error}. Recovery also failed: {rollback_error}') from error
        raise RuntimeError(f'Installation failed: {error}. Previous installation restored.' if had_previous
                           else f'Installation failed: {error}. Initial installation was rolled back.') from error
