// Sync service de Samsara — corre 3 cron loops independientes:
//   - drivers (default 60min)
//   - vehicles (default 60min)
//   - hos_clocks (default 5min)
//
// Coexistencia con Excel/manual (matchea Node):
//   Samsara es DUEÑO de: samsara_id, full_name (canonico), active.
//   Excel/manual es DUEÑO de: cdl_*, medical_card_*, endorsements,
//     phone, hire_date, company, location, division, notes.
// Si data_source ∈ {excel, samsara+excel, manual} → solo identidad.
// Sino → escribimos todo.

using BotDot.Web.Agent;
using BotDot.Web.Configuration;
using BotDot.Web.Data;
using Microsoft.Extensions.Options;

namespace BotDot.Web.Jobs;

public class SamsaraSyncService : BackgroundService
{
    private readonly IServiceProvider _services;
    private readonly SyncOptions _opts;
    private readonly ILogger<SamsaraSyncService> _log;

    public SamsaraSyncService(IServiceProvider services, IOptions<BotDotOptions> opts, ILogger<SamsaraSyncService> log)
    {
        _services = services;
        _opts = opts.Value.Sync;
        _log = log;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!_opts.Enabled)
        {
            _log.LogInformation("SamsaraSyncService deshabilitado (BotDot:Sync:Enabled=false)");
            return;
        }
        _log.LogInformation("SamsaraSyncService iniciado (drivers={D}min, vehicles={V}min, hos={H}min)",
            _opts.DriversIntervalMinutes, _opts.VehiclesIntervalMinutes, _opts.HosIntervalMinutes);

        // Correr una primera vez al startup, despues respetar intervalos.
        var driversTask = LoopAsync("drivers", _opts.DriversIntervalMinutes, RunDriversAsync, stoppingToken);
        var vehiclesTask = LoopAsync("vehicles", _opts.VehiclesIntervalMinutes, RunVehiclesAsync, stoppingToken);
        var hosTask = LoopAsync("hos_clocks", _opts.HosIntervalMinutes, RunHosClocksAsync, stoppingToken);

        await Task.WhenAll(driversTask, vehiclesTask, hosTask);
    }

    private async Task LoopAsync(string name, int intervalMin, Func<CancellationToken, Task> work, CancellationToken ct)
    {
        // Pequeno delay inicial para que el server termine de arrancar antes
        // de la primera corrida (evita ruido en logs del startup).
        try { await Task.Delay(TimeSpan.FromSeconds(10), ct); } catch (OperationCanceledException) { return; }

        while (!ct.IsCancellationRequested)
        {
            try { await work(ct); }
            catch (OperationCanceledException) { return; }
            catch (Exception ex)
            {
                // Captura defensiva — un error en una corrida NO debe matar el background service.
                _log.LogError(ex, "sync {Name} loop fallo (continua)", name);
            }
            try { await Task.Delay(TimeSpan.FromMinutes(intervalMin), ct); }
            catch (OperationCanceledException) { return; }
        }
    }

    public async Task RunDriversAsync(CancellationToken ct = default)
    {
        using var scope = _services.CreateScope();
        var samsara = scope.ServiceProvider.GetRequiredService<ISamsaraClient>();
        var db = scope.ServiceProvider.GetRequiredService<IDbAccess>();
        var runner = scope.ServiceProvider.GetRequiredService<SamsaraSyncRunner>();

        await runner.RunAsync("drivers", async () =>
        {
            var list = await samsara.ListDriversAsync(ct);
            int n = 0;
            foreach (var d in list)
            {
                var existing = await db.QueryOneAsync<DriverIdSourceRow>(
                    @"SELECT id AS Id, data_source AS DataSource FROM drivers
                      WHERE samsara_id = @Sid OR (samsara_id IS NULL AND full_name = @Name)
                      LIMIT 1",
                    new { Sid = d.SamsaraId, Name = d.Name });

                bool ownsCompliance = existing != null &&
                    (existing.DataSource == "excel" || existing.DataSource == "samsara+excel" || existing.DataSource == "manual");

                if (existing != null)
                {
                    if (ownsCompliance)
                    {
                        // Solo identidad
                        await db.ExecuteAsync(
                            @"UPDATE drivers SET
                                samsara_id = @Sid,
                                full_name = @Name,
                                active = 1,
                                last_synced_at = CURRENT_TIMESTAMP
                              WHERE id = @Id",
                            new { Sid = d.SamsaraId, Name = string.IsNullOrEmpty(d.Name) ? "(sin nombre)" : d.Name, Id = existing.Id });
                    }
                    else
                    {
                        await db.ExecuteAsync(
                            @"UPDATE drivers SET
                                samsara_id = @Sid,
                                full_name = @Name,
                                cdl_number = @CdlN,
                                cdl_state = @CdlS,
                                cdl_expiration = @CdlE,
                                medical_card_expiration = @MedE,
                                endorsements = @End,
                                active = 1,
                                data_source = 'samsara',
                                last_synced_at = CURRENT_TIMESTAMP
                              WHERE id = @Id",
                            new
                            {
                                Sid = d.SamsaraId,
                                Name = string.IsNullOrEmpty(d.Name) ? "(sin nombre)" : d.Name,
                                CdlN = NullIfEmpty(d.CdlNumber),
                                CdlS = NullIfEmpty(d.CdlState),
                                CdlE = NullIfEmpty(d.CdlExpiration),
                                MedE = NullIfEmpty(d.MedicalCardExpiration),
                                End = NullIfEmpty(d.Endorsements),
                                Id = existing.Id,
                            });
                    }
                }
                else
                {
                    await db.ExecuteAsync(
                        @"INSERT INTO drivers
                            (samsara_id, full_name, cdl_number, cdl_state, cdl_expiration,
                             medical_card_expiration, endorsements, active, data_source, last_synced_at)
                          VALUES (@Sid, @Name, @CdlN, @CdlS, @CdlE, @MedE, @End, 1, 'samsara', CURRENT_TIMESTAMP)",
                        new
                        {
                            Sid = d.SamsaraId,
                            Name = string.IsNullOrEmpty(d.Name) ? "(sin nombre)" : d.Name,
                            CdlN = NullIfEmpty(d.CdlNumber),
                            CdlS = NullIfEmpty(d.CdlState),
                            CdlE = NullIfEmpty(d.CdlExpiration),
                            MedE = NullIfEmpty(d.MedicalCardExpiration),
                            End = NullIfEmpty(d.Endorsements),
                        });
                }
                n++;
            }
            return n;
        });
    }

    public async Task RunVehiclesAsync(CancellationToken ct = default)
    {
        using var scope = _services.CreateScope();
        var samsara = scope.ServiceProvider.GetRequiredService<ISamsaraClient>();
        var db = scope.ServiceProvider.GetRequiredService<IDbAccess>();
        var runner = scope.ServiceProvider.GetRequiredService<SamsaraSyncRunner>();

        await runner.RunAsync("vehicles", async () =>
        {
            var list = await samsara.ListVehiclesAsync(ct);
            int n = 0;
            foreach (var v in list)
            {
                // Schema vehicles (migration 001): unit_number, annual_inspection_date,
                // oos_status (NO unit/annual_inspection/oos como llamamos en el modelo).
                await db.ExecuteAsync(
                    @"INSERT INTO vehicles (samsara_id, vin, unit_number, make, model, year, annual_inspection_date, oos_status, active, last_synced_at)
                      VALUES (@Sid, @Vin, @Unit, @Make, @Model, @Year, @Annual, @Oos, 1, CURRENT_TIMESTAMP)
                      ON DUPLICATE KEY UPDATE
                        vin = VALUES(vin), unit_number = VALUES(unit_number), make = VALUES(make),
                        model = VALUES(model), year = VALUES(year),
                        annual_inspection_date = VALUES(annual_inspection_date),
                        oos_status = VALUES(oos_status),
                        last_synced_at = CURRENT_TIMESTAMP",
                    new
                    {
                        Sid = v.SamsaraId,
                        Vin = v.Vin,
                        Unit = v.Unit,
                        Make = v.Make,
                        Model = v.Model,
                        Year = v.Year,
                        Annual = NullIfEmpty(v.AnnualInspection),
                        Oos = v.Oos ? 1 : 0,
                    });
                n++;
            }
            return n;
        });
    }

    public async Task RunHosClocksAsync(CancellationToken ct = default)
    {
        using var scope = _services.CreateScope();
        var samsara = scope.ServiceProvider.GetRequiredService<ISamsaraClient>();
        var db = scope.ServiceProvider.GetRequiredService<IDbAccess>();
        var runner = scope.ServiceProvider.GetRequiredService<SamsaraSyncRunner>();

        await runner.RunAsync("hos_clocks", async () =>
        {
            var clocks = await samsara.GetHosClocksAsync(ct);
            int n = 0;
            foreach (var c in clocks)
            {
                if (string.IsNullOrEmpty(c.DriverId)) continue;
                var driveLeft = Math.Max(0, 11 * 60 - c.DrivingTimeSec / 60);
                var dutyLeft = Math.Max(0, 14 * 60 - c.OnDutyTimeSec / 60);
                var cycleLeft = Math.Max(0, 70 * 60 - c.CycleTimeSec / 60);

                await db.ExecuteAsync(
                    @"INSERT INTO driver_hos_cache
                        (samsara_driver_id, driver_name, clock_state,
                         drive_used_min, drive_remaining_min,
                         duty_used_min, duty_remaining_min,
                         cycle_used_min, cycle_remaining_min,
                         raw_clock_json, fetched_at)
                      VALUES (@Did, @Name, @State, @Dum, @Dre, @Dum2, @Dre2, @Cum, @Cre, @Raw, CURRENT_TIMESTAMP(6))
                      ON DUPLICATE KEY UPDATE
                        driver_name = VALUES(driver_name),
                        clock_state = VALUES(clock_state),
                        drive_used_min = VALUES(drive_used_min),
                        drive_remaining_min = VALUES(drive_remaining_min),
                        duty_used_min = VALUES(duty_used_min),
                        duty_remaining_min = VALUES(duty_remaining_min),
                        cycle_used_min = VALUES(cycle_used_min),
                        cycle_remaining_min = VALUES(cycle_remaining_min),
                        raw_clock_json = VALUES(raw_clock_json),
                        fetched_at = VALUES(fetched_at)",
                    new
                    {
                        Did = c.DriverId,
                        Name = c.DriverName,
                        State = c.ClockState,
                        Dum = c.DrivingTimeSec / 60,
                        Dre = driveLeft,
                        Dum2 = c.OnDutyTimeSec / 60,
                        Dre2 = dutyLeft,
                        Cum = c.CycleTimeSec / 60,
                        Cre = cycleLeft,
                        Raw = System.Text.Json.JsonSerializer.Serialize(c),
                    });
                n++;
            }
            return n;
        });
    }

    private static string? NullIfEmpty(string? s) => string.IsNullOrEmpty(s) ? null : s;

    private class DriverIdSourceRow
    {
        public long Id { get; set; }
        public string? DataSource { get; set; }
    }
}
